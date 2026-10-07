# A single-tenant OpenADLC install on Google Cloud.
#
# One VM runs hostd and a container per task, because a task's computer is a
# container with tmux inside, which does not fit a serverless runtime. The bridge and the console run on Cloud Run behind IAP. Nothing here
# holds a production credential for the products OpenADLC builds: this project is
# deliberately separate from them.

terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source = "hashicorp/google"
      # 6.9 is where `invoker_iam_disabled` arrived, which is how the two
      # services are public without an `allUsers` binding (see below).
      version = "~> 6.9"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.9"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

data "google_project" "this" {}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

# IAP's own service agent. A new project does not have one until something asks
# for it, and without it the first cloud console answered every signed-in
# person with "The IAP service account is not provisioned".
resource "google_project_service_identity" "iap" {
  provider = google-beta
  service  = "iap.googleapis.com"

  depends_on = [google_project_service.enabled]
}

locals {
  # The bridge's URL, written out rather than read from the service. The console
  # needs it and the bridge needs the console's backend (for the IAP audience),
  # so reading it from the resource is a cycle. This is the deterministic form
  # Cloud Run gives every service.
  bridge_host = "${var.name_prefix}-bridge-${data.google_project.this.number}.${var.region}.run.app"
  bridge_url  = "https://${local.bridge_host}"

  # The egress a bot needs and nothing more: GitHub, package registries, the
  # engine APIs, and the Google APIs the platform itself calls.
  allowed_egress_domains = concat(
    [
      "github.com",
      "api.github.com",
      "codeload.github.com",
      "objects.githubusercontent.com",
      "registry.npmjs.org",
      "pypi.org",
      "files.pythonhosted.org",
      "api.anthropic.com",
      "api.openai.com",
      # xAI and its subdomains: api.x.ai for a key, auth.x.ai for signing a
      # subscription in — with only api.x.ai open, the console's "Sign in"
      # for an xAI subscription failed with the proxy's "tunnel error".
      "x.ai",
      # A Grok subscription (rather than an API key) talks to grok.com and its
      # `cli-chat-proxy` subdomain; with only api.x.ai open the sign-in check
      # timed out on the first cloud host.
      "grok.com",
      # Signing a ChatGPT plan in to Codex, as the xAI sign-in above.
      "auth.openai.com",
      # And where Codex signed in with a ChatGPT plan sends its model calls:
      # chatgpt.com/backend-api/codex, not api.openai.com. With only the
      # sign-in host open, every such seat's first model call was refused.
      "chatgpt.com",
      # The package repositories infra/local/Dockerfile.bot installs from.
      # hostd's weekly engine update builds the bot image on the host, and a
      # build step leaves through this proxy like a bot does: without these
      # the build dies at its first apt-get. The engine CLIs themselves come
      # from registry.npmjs.org, above.
      "deb.debian.org",
      "deb.nodesource.com",
      # A named Node version is the tarball from nodejs.org, not the nodesource
      # major. The weekly update sets NODE_VERSION, and the build died at that
      # curl: nodejs.org was not on this list.
      "nodejs.org",
      "cli.github.com",
      # The bot image's base, debian:12-slim, from Docker Hub: its token
      # service, its registry and the CDN its layers come from. Found on the
      # first cloud engine update, which failed "failed to fetch anonymous
      # token … Forbidden" before its first step.
      "auth.docker.io",
      "registry-1.docker.io",
      "production.cloudflare.docker.com",
      "secretmanager.googleapis.com",
      "logging.googleapis.com",
      # A task reports its state, usage and gates to the bridge, and that is a
      # Cloud Run URL — so the proxy has to let exactly that name through.
      local.bridge_host,
    ],
    var.extra_allowed_domains,
    # The private registry hostd hands tasks a token for.
    var.registry_host != "" ? [var.registry_host] : []
  )

  # Squid matches a leading dot as "this name and anything under it", which is
  # how a CDN stays reachable without opening its parent domain. A bare name
  # matches exactly that host.
  squid_domains = join(" ", [for domain in local.allowed_egress_domains : ".${domain}"])

  # The host's cloud-init: the one this module ships unless the operator
  # replaced it. If they did, the egress allowlist is theirs to enforce —
  # nothing else in the module does it.
  host_cloud_init = var.host_cloud_init != "" ? var.host_cloud_init : templatefile(
    "${path.module}/cloud-init/host.yaml",
    {
      allowed_domains = local.squid_domains
      proxy_image     = var.egress_proxy_image
      hostd_image     = var.hostd_image
      hostd_port      = var.hostd_port
      bot_image       = var.bot_image
      console_domain  = var.console_domain
      project_id      = var.project_id
      region          = var.region
      zone            = var.zone
      host_name       = "${var.name_prefix}-host-1"
      bridge_url      = local.bridge_url
      github_org      = var.github_organization
      github_client   = var.github_app_client_id
      humans          = join(",", var.humans)
      automation_bot  = var.automation_bot
      registry_host   = var.registry_host
      database_secret = google_secret_manager_secret.database_url.secret_id
      # The certificate authority the database URL's `sslrootcert` names; the
      # prepare script writes it where the URL looks for it.
      database_ca_secret = google_secret_manager_secret.database_ca.secret_id
    }
  )

  services = [
    "compute.googleapis.com",
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "secretmanager.googleapis.com",
    "iap.googleapis.com",
    "artifactregistry.googleapis.com",
    # Private IP for Cloud SQL is a peering this API makes; without it the
    # first apply stops at the connection.
    "servicenetworking.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    # The host's and the bridge's service accounts.
    "iam.googleapis.com",
  ]
}

# A resource that reaches none of these through a reference waits for them with
# `depends_on`: on a new project Terraform otherwise makes it in parallel with
# turning its API on, and the first apply stops with SERVICE_DISABLED.
resource "google_project_service" "enabled" {
  for_each = toset(local.services)

  service            = each.key
  disable_on_destroy = false
}

# ---------------------------------------------------------------- network
# The host has no external address. Egress goes through Cloud NAT so it can be
# confined to an allowlist, and ingress is only from IAP and the bridge.

resource "google_compute_network" "fleet" {
  name                    = "${var.name_prefix}-network"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.enabled]
}

resource "google_compute_subnetwork" "fleet" {
  name                     = "${var.name_prefix}-subnet"
  ip_cidr_range            = var.subnet_cidr
  region                   = var.region
  network                  = google_compute_network.fleet.id
  private_ip_google_access = true
}

resource "google_compute_router" "fleet" {
  name    = "${var.name_prefix}-router"
  region  = var.region
  network = google_compute_network.fleet.id
}

resource "google_compute_router_nat" "fleet" {
  name                               = "${var.name_prefix}-nat"
  router                             = google_compute_router.fleet.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

# Two callers reach the host, and each has its own rule so that removing one
# cannot silently remove the other.
#
#   from_iap     a person, for `tmux attach` take-over through the terminal
#                gateway, and for SSH. Only IAP's own range, because the host
#                has no external address and IAP is the only way in.
#   from_bridge  the bridge, for hostd's API — starting a task, killing a
#                session, restarting a container. The bridge is Cloud Run with
#                direct VPC egress onto this subnet, so it comes from the
#                subnet's range, not from IAP's.
#
# Without the second rule the deny below catches the bridge and no task can ever
# start. Which caller each rule serves is written here because the next edit will
# be someone tightening one of them.

resource "google_compute_firewall" "from_iap" {
  name      = "${var.name_prefix}-allow-iap"
  network   = google_compute_network.fleet.name
  direction = "INGRESS"

  allow {
    protocol = "tcp"
    ports    = ["22", tostring(var.hostd_port)]
  }

  # IAP's forwarding range. Documented by Google and stable.
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["fleet-host"]
}

resource "google_compute_firewall" "from_bridge" {
  name      = "${var.name_prefix}-allow-bridge"
  network   = google_compute_network.fleet.name
  direction = "INGRESS"

  allow {
    protocol = "tcp"
    ports    = [tostring(var.hostd_port)]
  }

  # The subnet the bridge's VPC interface draws from. Not 22: the bridge has no
  # business on the host's shell, and hostd's API is the whole of what it needs.
  source_ranges = [var.subnet_cidr]
  target_tags   = ["fleet-host"]
}

# Egress. Before these rules the module had no EGRESS rules at all, and
# everything left the host unhindered while `docs/security.md` described an
# enforced allowlist.
#
# A firewall cannot hold a list of domain names — the allowlist is enforced by
# name in the proxy on the host. What these rules do is stop anything reaching
# the internet on a port the proxy does not use, so a process that ignores
# HTTP_PROXY and opens its own socket to port 4444 does not get out.
resource "google_compute_firewall" "egress_web" {
  name      = "${var.name_prefix}-allow-egress-web"
  network   = google_compute_network.fleet.name
  direction = "EGRESS"
  priority  = 1000

  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }

  destination_ranges = ["0.0.0.0/0"]
  target_tags        = ["fleet-host"]
}

# Postgres on the private services range, and DNS, which the proxy needs to
# resolve the names it is allowlisting.
resource "google_compute_firewall" "egress_internal" {
  name      = "${var.name_prefix}-allow-egress-internal"
  network   = google_compute_network.fleet.name
  direction = "EGRESS"
  priority  = 1000

  allow {
    protocol = "tcp"
    ports    = ["5432"]
  }

  allow {
    protocol = "udp"
    ports    = ["53"]
  }

  allow {
    protocol = "tcp"
    ports    = ["53"]
  }

  destination_ranges = ["10.0.0.0/8", "169.254.169.254/32"]
  target_tags        = ["fleet-host"]
}

resource "google_compute_firewall" "deny_other_egress" {
  name      = "${var.name_prefix}-deny-egress"
  network   = google_compute_network.fleet.name
  direction = "EGRESS"
  priority  = 65000

  deny {
    protocol = "all"
  }

  destination_ranges = ["0.0.0.0/0"]
  target_tags        = ["fleet-host"]
}

resource "google_compute_firewall" "deny_other_ingress" {
  name      = "${var.name_prefix}-deny-ingress"
  network   = google_compute_network.fleet.name
  direction = "INGRESS"
  priority  = 65000

  deny {
    protocol = "all"
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["fleet-host"]
}

# ---------------------------------------------------------------- the host
# hostd and one container per running task. Container limits are caps, not
# reservations: an idle container costs a few hundred megabytes, so the machine is
# sized for its working set rather than the sum of its ceilings.

resource "google_service_account" "host" {
  account_id   = "${var.name_prefix}-host"
  display_name = "OpenADLC host (hostd and the bot containers)"
  depends_on   = [google_project_service.enabled]
}

# What the secret store (packages/github/src/gcp-secrets.ts) calls, and nothing
# more: read the latest version, create a secret, add a version and destroy the
# ones it replaced, list and delete. Secret Manager's admin role also carried
# setIamPolicy on every secret in the project, so a compromised host or bridge
# could bind an outside account to the app's key or a refresh token, and that
# binding outlived revoking and rotating them. `get` on secrets and versions is
# what Cloud Run and cloud-init resolve `latest` with. No condition on the
# secret's name: the module's own secrets are `<name_prefix>-…`, not `fleet-`,
# and create and list are checked on the project, which a name condition denies.
resource "google_project_iam_custom_role" "secrets" {
  project     = var.project_id
  role_id     = "${replace(var.name_prefix, "-", "_")}_secrets"
  title       = "OpenADLC secret store"
  description = "Read and write OpenADLC's secrets, without changing who may read them."
  permissions = [
    "secretmanager.secrets.create",
    "secretmanager.secrets.delete",
    "secretmanager.secrets.get",
    "secretmanager.secrets.list",
    "secretmanager.versions.access",
    "secretmanager.versions.add",
    "secretmanager.versions.destroy",
    "secretmanager.versions.get",
    "secretmanager.versions.list",
  ]
  depends_on = [google_project_service.enabled]
}

# The host reads the per-bot credentials hostd hands a task, and the database
# URL; hostd holds no refresh token and writes nothing. It writes through the
# CLI a person runs on it: `fleetadlc restore` puts an install's secrets back,
# and with the bridge stopped the CLI refreshes a bot's token itself and saves
# the one GitHub rotated (`fleetadlc auth login` hands a sign-in to the bridge,
# which saves it). It has no access to any product project.
resource "google_project_iam_member" "host_secrets" {
  project = var.project_id
  role    = google_project_iam_custom_role.secrets.name
  member  = "serviceAccount:${google_service_account.host.email}"
}

resource "google_project_iam_member" "host_logging" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.host.email}"
}

resource "google_project_iam_member" "host_images" {
  project = var.project_id
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:${google_service_account.host.email}"
}

resource "google_project_iam_member" "host_metrics" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.host.email}"
}

resource "google_compute_instance" "host" {
  name         = "${var.name_prefix}-host-1"
  machine_type = var.host_machine_type
  zone         = var.zone
  tags         = ["fleet-host"]

  boot_disk {
    initialize_params {
      image = var.host_image
      size  = var.host_disk_gb
      type  = "pd-ssd"
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.fleet.id
    # No access_config block: the host has no external IP.
  }

  service_account {
    email  = google_service_account.host.email
    scopes = ["cloud-platform"]
  }

  metadata = {
    enable-oslogin = "TRUE"
    # Container-Optimized OS's own log and metric agents: this is how the
    # proxy's TCP_DENIED lines reach Cloud Logging and the egress metric.
    google-logging-enabled    = "true"
    google-monitoring-enabled = "true"
    user-data                 = local.host_cloud_init
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  allow_stopping_for_update = true
  depends_on                = [google_compute_router_nat.fleet]
}

# ---------------------------------------------------------------- database
# fleet_db holds the leases, the ledger and the audit trail. Nothing else
# reconstructs them, so it is the one thing here that is backed up.

resource "google_compute_global_address" "private_ip" {
  name          = "${var.name_prefix}-sql-range"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.fleet.id
}

resource "google_service_networking_connection" "sql" {
  network                 = google_compute_network.fleet.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_ip.name]
}

resource "google_sql_database_instance" "fleet" {
  name             = "${var.name_prefix}-db"
  database_version = "POSTGRES_16"
  region           = var.region

  settings {
    # Postgres 16 defaults a new instance to Enterprise Plus, which accepts only
    # its own performance tiers — the first apply was refused on the tier below.
    edition           = "ENTERPRISE"
    tier              = var.database_tier
    availability_type = var.database_high_availability ? "REGIONAL" : "ZONAL"
    disk_autoresize   = true

    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.fleet.id
      # Without it the instance took a plaintext connection as readily as an
      # encrypted one, so a client whose URL lost its TLS settings would have
      # carried the password and every row across the peering in the clear.
      ssl_mode = "ENCRYPTED_ONLY"
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "03:00"

      backup_retention_settings {
        retained_backups = 7
      }
    }

    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }
  }

  deletion_protection = var.database_deletion_protection
  depends_on          = [google_service_networking_connection.sql]
}

resource "google_sql_database" "fleet" {
  name     = "fleet_db"
  instance = google_sql_database_instance.fleet.name
}

# A built-in user with a generated password, kept in Secret Manager, is what a
# plain Postgres client can use. The URL the bridge and the host used to connect
# with named a user that did not exist, with no password, on an instance that
# only accepts IAM logins through the connector, which neither of them uses.
resource "random_password" "database" {
  length  = 32
  special = false
}

resource "google_sql_user" "fleet" {
  name     = "fleet"
  instance = google_sql_database_instance.fleet.name
  password = random_password.database.result
}

resource "google_secret_manager_secret" "database_url" {
  secret_id = "${var.name_prefix}-database-url"

  replication {
    auto {}
  }

  depends_on = [google_project_service.enabled]
}

# TLS, checked against the instance's own certificate authority. Without
# `sslmode` the bridge and the host sent the password, and everything in the
# database, in the clear; with `no-verify` anything on the path could have
# answered in the database's place. A bare `sslmode=require` is read by
# node-postgres as verify-full, and Cloud SQL's certificate names
# `<project>:<instance>` under a CA of its own, not the private IP the clients
# dial, so that would take both down. `verify-ca` with `uselibpqcompat` checks
# the chain against the file `sslrootcert` names and skips the name. The file
# is at the same path for the bridge (a secret volume) and for the host (the
# prepare script in cloud-init writes it).
locals {
  database_ca_dir  = "/var/lib/fleet/database-ca"
  database_ca_file = "server-ca.pem"
}

resource "google_secret_manager_secret_version" "database_url" {
  secret      = google_secret_manager_secret.database_url.id
  secret_data = "postgres://${google_sql_user.fleet.name}:${random_password.database.result}@${google_sql_database_instance.fleet.private_ip_address}:5432/${google_sql_database.fleet.name}?sslmode=verify-ca&uselibpqcompat=true&sslrootcert=${local.database_ca_dir}/${local.database_ca_file}"
}

# Not a secret, but kept beside the URL rather than in instance metadata, which
# holds nothing a client of the database needs.
resource "google_secret_manager_secret" "database_ca" {
  secret_id = "${var.name_prefix}-database-ca"

  replication {
    auto {}
  }

  depends_on = [google_project_service.enabled]
}

resource "google_secret_manager_secret_version" "database_ca" {
  secret      = google_secret_manager_secret.database_ca.id
  secret_data = google_sql_database_instance.fleet.server_ca_cert[0].cert
}

# ---------------------------------------------------------------- services
# The bridge and the console. The console is a view of the bridge and holds no
# database of its own: it reaches the VPC only on its way to the bridge's
# run.app URL, and runs as an account of its own with no roles, so a console
# taken over gets no token that reads a secret or the database.

resource "google_service_account" "bridge" {
  account_id   = "${var.name_prefix}-bridge"
  display_name = "OpenADLC bridge"
  depends_on   = [google_project_service.enabled]
}

# No role, on purpose: the console calls no Google API, and the bridge's
# invoker check is off, so it needs no identity to call it. It ran as the
# bridge's account, whose token the metadata server would have handed any
# request forgery in the console, with every secret and the database behind it.
resource "google_service_account" "console" {
  account_id   = "${var.name_prefix}-console"
  display_name = "OpenADLC console"
  depends_on   = [google_project_service.enabled]
}

resource "google_project_iam_member" "bridge_secrets" {
  project = var.project_id
  role    = google_project_iam_custom_role.secrets.name
  member  = "serviceAccount:${google_service_account.bridge.email}"
}

resource "google_project_iam_member" "bridge_sql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.bridge.email}"
}

# GitHub signs every delivery of the app's webhook, and that signature is the
# only thing authenticating the one path this install exposes to the internet.
# The module wires it: without a secret the bridge verifies nothing, and a public
# `/webhooks/github` that verifies nothing will run whatever is posted to it.
resource "google_secret_manager_secret" "webhook" {
  secret_id = "${var.name_prefix}-webhook-secret"

  replication {
    auto {}
  }

  depends_on = [google_project_service.enabled]
}

resource "google_secret_manager_secret_version" "webhook" {
  secret      = google_secret_manager_secret.webhook.id
  secret_data = var.webhook_secret
}

resource "google_cloud_run_v2_service" "bridge" {
  name = "${var.name_prefix}-bridge"

  # The API fills in a service-level `scaling` block of zeros that this module
  # never sets, and every plan offered to remove it; `gcloud run services
  # update` (how a new image is rolled out) leaves its own name in `client`.
  lifecycle {
    ignore_changes = [scaling, client, client_version]
  }
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

  # No invoker check. GitHub cannot present a Google identity, and the
  # organization policy refuses `allUsers` as a member, so the old
  # `allUsers` binding could not be applied here. What still stands between the
  # internet and the bridge: ingress admits only the load balancer and the VPC,
  # the load balancer routes `/webhooks/github` alone, and every delivery is
  # checked against FLEETADLC_WEBHOOK_SECRET.
  invoker_iam_disabled = true
  deletion_protection  = false

  template {
    service_account = google_service_account.bridge.email

    vpc_access {
      network_interfaces {
        network    = google_compute_network.fleet.id
        subnetwork = google_compute_subnetwork.fleet.id
      }
      egress = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = var.bridge_image
      # Migrating here as well as on the host: a revision that starts against an
      # empty database fails its startup probe, and with it the apply. The
      # migration takes a lock, so the two cannot apply the same file twice.
      command = ["sh", "-c", "node packages/db/dist/cli/migrate.js && exec node apps/bridge/dist/main.js"]

      ports {
        container_port = 47311
      }

      # The version this apply wrote, not `latest`. Cloud Run reads a secret
      # only when an instance starts, and a new version does not roll the
      # service: the running revision kept the old URL, and lost the database
      # once the instance refused it. Pinned, a new URL is a new revision.
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.database_url.secret_id
            version = google_secret_manager_secret_version.database_url.version
          }
        }
      }

      env {
        name  = "FLEETADLC_SECRET_STORE"
        value = "gcp"
      }

      env {
        name  = "FLEETADLC_GCP_PROJECT"
        value = var.project_id
      }

      env {
        name  = "FLEETADLC_PUBLIC_URL"
        value = "https://${var.console_domain}"
      }

      env {
        name  = "FLEETADLC_CONSOLE_URL"
        value = "https://${var.console_domain}"
      }

      # Only when one is named; without it the bridge takes the bot whose role
      # is `automation`.
      dynamic "env" {
        for_each = var.automation_bot != "" ? [var.automation_bot] : []
        content {
          name  = "FLEETADLC_AUTOMATION_BOT"
          value = env.value
        }
      }

      # Who is asking is read from IAP's signed assertion, not from a header
      # anything that reaches the bridge could set.
      env {
        name  = "FLEETADLC_IDENTITY_MODE"
        value = "iap"
      }

      env {
        name  = "FLEETADLC_IAP_AUDIENCE"
        value = "/projects/${data.google_project.this.number}/global/backendServices/${google_compute_backend_service.console.generated_id}"
      }

      env {
        name  = "FLEETADLC_HOSTD_URL"
        value = "http://${google_compute_instance.host.network_interface[0].network_ip}:${var.hostd_port}"
      }

      env {
        name  = "FLEETADLC_GITHUB_ORG"
        value = var.github_organization
      }

      # From Secret Manager, not from a variable in the clear: a value set here
      # is readable by anyone who can describe the service.
      env {
        name = "FLEETADLC_WEBHOOK_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.webhook.secret_id
            version = "latest"
          }
        }
      }

      env {
        name  = "FLEETADLC_GITHUB_CLIENT_ID"
        value = var.github_app_client_id
      }

      env {
        name  = "FLEETADLC_HUMANS"
        value = join(",", var.humans)
      }

      # Who becomes the first admin while the console has no users: everyone
      # in admin_emails, or, when that is empty, every `user:` among the
      # console's IAP members. Read only while the users table is empty.
      env {
        name  = "FLEETADLC_ADMIN_EMAILS"
        value = join(",", var.admin_emails)
      }

      env {
        name  = "FLEETADLC_CONSOLE_MEMBERS"
        value = join(",", var.console_members)
      }

      # The dispatcher runs in the bridge; without this nothing starts work.
      env {
        name  = "FLEETADLC_DISPATCH_IN_BRIDGE"
        value = "1"
      }

      volume_mounts {
        name       = "database-ca"
        mount_path = local.database_ca_dir
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
      }
    }

    # The CA the database URL's `sslrootcert` names, at the path the host uses.
    volumes {
      name = "database-ca"
      secret {
        secret = google_secret_manager_secret.database_ca.secret_id
        items {
          version = google_secret_manager_secret_version.database_ca.version
          path    = local.database_ca_file
        }
      }
    }

    scaling {
      # One instance: the bridge holds the event loop and its own in-memory token
      # cache, and there is nothing to gain from a second copy of it.
      min_instance_count = 1
      max_instance_count = 1
    }
  }

  depends_on = [
    google_secret_manager_secret_version.database_url,
    google_secret_manager_secret_version.database_ca,
    google_secret_manager_secret_version.webhook,
    google_project_iam_member.bridge_secrets,
  ]
}

resource "google_cloud_run_v2_service" "console" {
  name = "${var.name_prefix}-console"

  # The API fills in a service-level `scaling` block of zeros that this module
  # never sets, and every plan offered to remove it; `gcloud run services
  # update` (how a new image is rolled out) leaves its own name in `client`.
  lifecycle {
    ignore_changes = [scaling, client, client_version]
  }
  location = var.region
  # Only through the load balancer, which is where IAP is. `INGRESS_TRAFFIC_ALL`
  # would leave the Cloud Run URL answering the internet directly, with IAP
  # sitting beside it rather than in front of it.
  ingress = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

  # IAP in front of the load balancer is the check; see the bridge.
  invoker_iam_disabled = true
  deletion_protection  = false

  template {
    service_account = google_service_account.console.email

    vpc_access {
      network_interfaces {
        network    = google_compute_network.fleet.id
        subnetwork = google_compute_subnetwork.fleet.id
      }
      # All traffic, not private ranges: the bridge is a run.app URL, and its
      # ingress admits the VPC but not the internet. Sent the direct way the
      # console's every call to it was refused.
      egress = "ALL_TRAFFIC"
    }

    containers {
      image = var.console_image
      # Next itself, not `pnpm start`: corepack fetches pnpm from npm the first
      # time it runs, and a fresh Cloud Run instance timed out doing that and
      # never listened.
      command = ["node_modules/.bin/next", "start", "--port", "47300", "--hostname", "0.0.0.0"]

      # Cloud Run probes 8080 unless told otherwise, and the console listens here.
      ports {
        container_port = 47300
      }

      env {
        name  = "FLEETADLC_BRIDGE_URL"
        value = local.bridge_url
      }

      # The name the console is served under. It answers only names it is
      # served under, so a page on a name rebound to it learns nothing.
      env {
        name  = "FLEETADLC_CONSOLE_URL"
        value = "https://${var.console_domain}"
      }

      # Only turns on the console's report of a request that arrived without
      # IAP's assertion, which on an install behind IAP should never happen.
      env {
        name  = "FLEETADLC_IDENTITY_MODE_EXPECTED"
        value = "iap"
      }

      # The browser opens the take-over socket itself, and the host has no
      # address it could reach. This sends it back through the load balancer,
      # where `/terminal` is a backend of its own admitted to the operators.
      env {
        name  = "NEXT_PUBLIC_FLEETADLC_TERMINAL_URL"
        value = "wss://${var.console_domain}"
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }
    }
  }
}

# ------------------------------------------------------- the way in
# IAP is a property of a compute *backend service*, not of a Cloud Run service.
# The binding here used to name the Cloud Run service directly, and the module
# created no backend service, URL map or forwarding rule — so IAP was in front of
# nothing, and `var.operators` was declared and never read. `terraform validate`
# had no complaint about any of it.
#
# One load balancer, two backends, because two surfaces deserve different
# audiences:
#
#   /terminal   the take-over gateway on the host. A shell inside a bot's
#               computer, admitted to var.operators alone.
#   everything  the console. Admitted to var.console_members.
#
# Both Cloud Run services are reachable only through a load balancer (and, for
# the bridge, the VPC). IAP is the gate; the ingress restriction is what stops
# anyone going round it.

resource "google_compute_global_address" "console" {
  name       = "${var.name_prefix}-console-ip"
  depends_on = [google_project_service.enabled]
}

# Cloud Run behind a global external load balancer, through a serverless NEG.
resource "google_compute_region_network_endpoint_group" "console" {
  name                  = "${var.name_prefix}-console-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = google_cloud_run_v2_service.console.name
  }
}

resource "google_compute_backend_service" "console" {
  name                  = "${var.name_prefix}-console-backend"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"

  backend {
    group = google_compute_region_network_endpoint_group.console.id
  }

  # There is no switch to turn IAP off, here or on the terminal below. The URL
  # map's default service answers anyone on the internet, by domain or bare
  # IP, and without IAP's assertion the bridge's local mode made every name it
  # did not know an admin (apps/bridge/src/roles.ts): anyone could download
  # every credential through /v1/backup and mint terminal tokens.
  #
  # Without a client of the operator's own, IAP signs people in with Google's
  # managed OAuth client, which Google documents as admitting only identities
  # in the project's own organization: a @gmail.com collaborator listed in
  # console_members is turned away at sign-in. Empty leaves the managed one.
  iap {
    enabled              = true
    oauth2_client_id     = var.iap_oauth2_client_id != "" ? var.iap_oauth2_client_id : null
    oauth2_client_secret = var.iap_oauth2_client_secret != "" ? var.iap_oauth2_client_secret : null
  }

  log_config {
    enable      = true
    sample_rate = 1.0
  }

  # Here rather than as a validation: one variable's validation may name another
  # only from Terraform 1.9, and the module accepts 1.6.
  lifecycle {
    precondition {
      condition     = (var.iap_oauth2_client_id == "") == (var.iap_oauth2_client_secret == "")
      error_message = "Set both iap_oauth2_client_id and iap_oauth2_client_secret, or neither: IAP needs the client's id and its secret together."
    }
  }
}

# The host, as a backend. The terminal gateway is a WebSocket on hostd's port and
# the browser opens it directly, so in a cloud install — where the host has no
# external address — it has to come through here or not at all.
resource "google_compute_instance_group" "host" {
  name = "${var.name_prefix}-host-group"
  zone = var.zone

  instances = [google_compute_instance.host.id]

  named_port {
    name = "hostd"
    port = var.hostd_port
  }
}

resource "google_compute_health_check" "hostd" {
  name = "${var.name_prefix}-hostd-health"

  # `/healthz` is the one hostd route that needs no credential, which is what
  # makes it usable as a health check.
  http_health_check {
    port         = var.hostd_port
    request_path = "/healthz"
  }

  depends_on = [google_project_service.enabled]
}

resource "google_compute_backend_service" "terminal" {
  name                  = "${var.name_prefix}-terminal-backend"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTP"
  port_name             = "hostd"
  health_checks         = [google_compute_health_check.hostd.id]

  # A take-over is a person at a shell. The default 30s would cut the socket.
  timeout_sec = 3600

  backend {
    group = google_compute_instance_group.host.id
  }

  # Always on, and with the same OAuth client; see the console's backend above.
  iap {
    enabled              = true
    oauth2_client_id     = var.iap_oauth2_client_id != "" ? var.iap_oauth2_client_id : null
    oauth2_client_secret = var.iap_oauth2_client_secret != "" ? var.iap_oauth2_client_secret : null
  }

  log_config {
    enable      = true
    sample_rate = 1.0
  }
}

# The bridge, reachable on exactly one path.
#
# The bridge is deployed with `ingress = INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER`,
# so GitHub's deliveries need this load balancer. Before it existed,
# `webhook_url` pointed the GitHub App's webhook at the Cloud Run URL, nothing
# GitHub sent could arrive, and the symptom was a board that stayed empty.
#
# No IAP on this backend, because GitHub cannot sign in to it. The URL map sends
# `/webhooks/github` here and nothing else, so the console API on the same
# service stays unreachable from outside, and the HMAC signature is what
# authenticates the delivery.
resource "google_compute_region_network_endpoint_group" "bridge" {
  name                  = "${var.name_prefix}-bridge-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = google_cloud_run_v2_service.bridge.name
  }
}

resource "google_compute_backend_service" "webhook" {
  name                  = "${var.name_prefix}-webhook-backend"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"

  backend {
    group = google_compute_region_network_endpoint_group.bridge.id
  }

  # Deliberately absent: an `iap {}` block here would refuse GitHub.

  log_config {
    enable      = true
    sample_rate = 1.0
  }
}

resource "google_compute_url_map" "console" {
  name            = "${var.name_prefix}-url-map"
  default_service = google_compute_backend_service.console.id

  host_rule {
    hosts        = [var.console_domain]
    path_matcher = "fleet"
  }

  path_matcher {
    name            = "fleet"
    default_service = google_compute_backend_service.console.id

    # The gateway, on its own backend so it can carry its own IAP binding.
    path_rule {
      paths   = ["/terminal", "/terminal/*"]
      service = google_compute_backend_service.terminal.id
    }

    # The one path GitHub reaches. Exactly this path: no wildcard, because the
    # rest of the bridge is the console's API and has no business being public.
    path_rule {
      paths   = ["/webhooks/github"]
      service = google_compute_backend_service.webhook.id
    }
  }
}

resource "google_compute_managed_ssl_certificate" "console" {
  name = "${var.name_prefix}-console-cert"

  managed {
    domains = [var.console_domain]
  }

  depends_on = [google_project_service.enabled]
}

# TLS 1.2 and up, with modern ciphers. Without a policy the load balancer takes
# GCP's default, which still accepts TLS 1.0; GitHub's deliveries and current
# browsers need nothing older than 1.2.
resource "google_compute_ssl_policy" "console" {
  name            = "${var.name_prefix}-ssl-policy"
  profile         = "MODERN"
  min_tls_version = "TLS_1_2"
  depends_on      = [google_project_service.enabled]
}

resource "google_compute_target_https_proxy" "console" {
  name             = "${var.name_prefix}-https-proxy"
  url_map          = google_compute_url_map.console.id
  ssl_certificates = [google_compute_managed_ssl_certificate.console.id]
  ssl_policy       = google_compute_ssl_policy.console.id
}

resource "google_compute_global_forwarding_rule" "console" {
  name                  = "${var.name_prefix}-https"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.console.id
  port_range            = "443"
  target                = google_compute_target_https_proxy.console.id
}

# The load balancer's health checks and proxies come from Google's own ranges,
# which the deny would otherwise catch — and an unhealthy backend serves nobody.
resource "google_compute_firewall" "from_load_balancer" {
  name      = "${var.name_prefix}-allow-lb"
  network   = google_compute_network.fleet.name
  direction = "INGRESS"

  allow {
    protocol = "tcp"
    ports    = [tostring(var.hostd_port)]
  }

  source_ranges = ["130.211.0.0/22", "35.191.0.0/16"]
  target_tags   = ["fleet-host"]
}

# ------------------------------------------------------- who is admitted
# The console is admitted to var.console_members. The terminal gateway is
# admitted to var.operators alone: take-over is a shell inside a bot's computer,
# and it is deliberately a smaller list than the one that may read the console.
resource "google_iap_web_backend_service_iam_binding" "console" {
  web_backend_service = google_compute_backend_service.console.name
  role                = "roles/iap.httpsResourceAccessor"
  members             = var.console_members
}

resource "google_iap_web_backend_service_iam_binding" "terminal" {
  web_backend_service = google_compute_backend_service.terminal.name
  role                = "roles/iap.httpsResourceAccessor"
  members             = var.operators
}

# Each binding had a `count` while IAP could be turned off. Moved rather than
# destroyed and made again, which would admit nobody for the moment between.
moved {
  from = google_iap_web_backend_service_iam_binding.console[0]
  to   = google_iap_web_backend_service_iam_binding.console
}

moved {
  from = google_iap_web_backend_service_iam_binding.terminal[0]
  to   = google_iap_web_backend_service_iam_binding.terminal
}

# Neither Cloud Run service checks its invoker (`invoker_iam_disabled` on each).
# The `allUsers` bindings that used to be here are refused by an organization
# policy that allows only the organization's own members, and a first apply
# stopped on them. What stands in their place is what always contained them:
# ingress that admits only the load balancer and the VPC, IAP in front of the
# console, the URL map routing exactly `/webhooks/github` to the bridge, and the
# delivery's HMAC signature checked against the secret above. Remove any one of
# those and the bridge's whole API is an open door.

# A denial has to be visible or the allowlist is a claim rather than a control.
# Squid writes TCP_DENIED for a destination outside the list; the firewall
# service writes `fleetadlc-egress-denied` for anything that tried to go round it.
resource "google_logging_metric" "egress_denied" {
  name   = "${var.name_prefix}-egress-denied"
  filter = <<-EOT
    resource.type="gce_instance"
    (textPayload:"TCP_DENIED" OR textPayload:"fleetadlc-egress-denied" OR jsonPayload.MESSAGE:"TCP_DENIED" OR jsonPayload.MESSAGE:"fleetadlc-egress-denied")
  EOT

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }

  depends_on = [google_project_service.enabled]
}

resource "google_monitoring_alert_policy" "egress_denied" {
  display_name = "${var.name_prefix}: a bot is trying to reach somewhere it may not"
  combiner     = "OR"

  conditions {
    display_name = "denied egress above baseline"

    condition_threshold {
      filter          = "resource.type=\"gce_instance\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.egress_denied.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = var.egress_denial_rate_threshold
      # The first minute over the threshold fires it. Five minutes in a row, as
      # it was, let a short probe through, and ALIGN_RATE counted per second:
      # the alert fired only above 300 refusals a minute, held for five.
      duration = "0s"

      # Refusals in each minute, the proxy's and the kernel's added together:
      # each log stream is a series of its own.
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  documentation {
    content = "A bot has no legitimate reason to develop new destinations. Check which name was refused. The engine vendors' analytics and crash-report hosts (Datadog's log intake, Mixpanel, Sentry) are refused on purpose and are never added to extra_allowed_domains, and neither is any shared ingestion host: it takes data under whatever key the caller brings, so allowing it is a way out for a bot. Add a name only when the work itself needs it."
  }

  notification_channels = var.notification_channels
  depends_on            = [google_project_service.enabled]
}

# ---------------------------------------------------------------- liveness
# A stopped host writes no uptime at all, and a threshold condition does not fire
# on data that is absent: the threshold this replaced ("uptime below 1") could
# never see the one thing it was for. An absence condition is what fires.
#
# This is the VM, not hostd. A running VM keeps reporting uptime while hostd
# crash-loops; a hostd that stops answering is the bridge's host check, a card
# on the board.
resource "google_monitoring_alert_policy" "host_heartbeat" {
  display_name = "${var.name_prefix}: the host stopped reporting"
  combiner     = "OR"

  conditions {
    display_name = "no VM uptime reported for five minutes"

    condition_absent {
      filter   = "resource.type=\"gce_instance\" AND metric.type=\"compute.googleapis.com/instance/uptime\" AND resource.label.instance_id=\"${google_compute_instance.host.instance_id}\""
      duration = "300s"

      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_RATE"
      }
    }
  }

  documentation {
    content = "The host VM has written no uptime for five minutes: it is stopped, or being recreated. Start it from the Compute Engine page. A host that runs while hostd does not is not this alert; the board shows it."
  }

  notification_channels = var.notification_channels
  depends_on            = [google_project_service.enabled]
}
