variable "project_id" {
  description = "The GCP project this install lives in. Use a project of its own: a compromise of a bot container should not land anywhere near the products OpenADLC builds."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run and Cloud SQL."
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "Zone for the host VM."
  type        = string
  default     = "us-central1-a"
}

variable "name_prefix" {
  description = "Prefix for the names of the resources this module makes. One install per project: the runtime secrets are named `fleet-<ref>` whatever this prefix is, and both service accounts, the host's and the bridge's, read and write every secret in the project, so two installs in one project would overwrite and read each other's credentials. Installs made before the rename to FleetADLC keep `fleet`, which `fleetadlc cloud plan` pins for them."
  type        = string
  default     = "fleetadlc"
}

variable "subnet_cidr" {
  type    = string
  default = "10.24.0.0/20"
}

# ---------------------------------------------------------------- the host

variable "host_machine_type" {
  description = "Sized for the tasks the host runs at once (FLEETADLC_HOST_CAPACITY_TASKS, 4 by default), each a container with its seat's CPUs and memory: e2-standard-8 holds about four with 6 GB builders; e2-standard-16 for six to eight. Limits are caps rather than reservations, so size for the working set, not their sum."
  type        = string
  default     = "e2-standard-8"
}

variable "host_disk_gb" {
  description = "One mirror per repository, each running task's clone (a copy of its mirror's objects, so the repository's size per task) and folder, each repository's package cache volume, the task database server and the bot images. 100 GB is comfortable for four tasks at once across a few repositories; raise it with capacity, and with large repositories, since every task at once holds a copy of its repository."
  type        = number
  default     = 100
}

variable "host_image" {
  type    = string
  default = "projects/cos-cloud/global/images/family/cos-stable"
}

variable "host_cloud_init" {
  description = "Override the host's cloud-init entirely. Leave empty for the one this module ships, which starts the egress proxy, the egress firewall and hostd (logging is Container-Optimized OS's own agent, turned on by instance metadata, and stays on either way). Setting this to your own means the egress allowlist is yours to enforce: nothing else does it. So is writing the database's certificate authority (the `<name_prefix>-database-ca` secret) to /var/lib/fleet/database-ca/server-ca.pem before hostd starts, where the database URL looks for it."
  type        = string
  default     = ""
}

variable "hostd_image" {
  description = "The hostd image the host runs. Build and push it from infra/local/Dockerfile.service."
  type        = string
}

variable "bot_image" {
  description = <<-EOT
    The image each bot's container runs, built by infra/local/build-bot-image.sh
    and pushed to a registry this host can reach.

    Before this variable, nothing provisioned it: hostd was started with the
    docker driver and no bot image was ever pulled or named, so every task on a
    fresh host failed to start. The same script builds it for a laptop, so the two cannot drift.

    No default, like hostd_image: the local tag `fleetadlc-bot:latest` is not
    pullable from a registry, and defaulting to it would put a `docker pull` that
    can only fail into the host's boot.
  EOT
  type        = string
}

# The proxy runs on the host's network, where the metadata server would hand it
# the host's token, so the image is pinned by digest: `edge` was whatever Docker
# Hub resolved it to when a host was made, and a changed or broken build reached
# every credential, or stopped every bot's egress. ubuntu/squid publishes no
# stable channel; this is Squid 6.6 on Ubuntu 24.04 from its beta channel, the
# image `edge` named when this was pinned. The tag is for the reader; the digest
# decides what is pulled.
variable "egress_proxy_image" {
  description = "The forward proxy that holds the egress allowlist. Any Squid image whose config is /etc/squid/squid.conf. The default is pinned by digest; pin an override by digest too (`<image>:<tag>@sha256:<digest>`), so a new host runs the same proxy as the last."
  type        = string
  default     = "ubuntu/squid:6.6-24.04_beta@sha256:6a097f68bae708cedbabd6188d68c7e2e7a38cedd05a176e1cc0ba29e3bbe029"
}

variable "egress_denial_rate_threshold" {
  description = "Denied egress attempts in a minute, the proxy's and the firewall's together, above which the alert fires. A bot has no legitimate reason to develop new destinations, so this is deliberately low. Refusals of the engine vendors' analytics and crash-report hosts count toward it, and those hosts are refused on purpose: see docs/security.md, Egress, before adding any name to extra_allowed_domains."
  type        = number
  default     = 5
}

variable "hostd_port" {
  description = "The port hostd serves, including the terminal gateway's upgrade path."
  type        = number
  default     = 47312
}

# ---------------------------------------------------------------- database

variable "database_tier" {
  type    = string
  default = "db-custom-1-3840"
}

variable "database_high_availability" {
  description = "Regional failover. fleet_db holds leases, the ledger and the audit trail; a lost hour of it is not recoverable from GitHub."
  type        = bool
  default     = false
}

variable "database_deletion_protection" {
  type    = bool
  default = true
}

# ---------------------------------------------------------------- images

variable "bridge_image" {
  description = "Image built from infra/local/Dockerfile.service."
  type        = string
}

variable "console_image" {
  description = "Image built from infra/local/Dockerfile.console."
  type        = string
}

# ---------------------------------------------------------------- github

variable "github_organization" {
  description = "The organization this install serves. One install serves one organization."
  type        = string
}

variable "github_app_client_id" {
  description = "Client id of the GitHub App used as the device-flow client. Not a secret, and not a credential: the refresh tokens live in Secret Manager, one per bot."
  type        = string
}

# ---------------------------------------------------------------- people

variable "automation_bot" {
  description = "The seat or bot name whose account the bridge's own GitHub automation acts as (labels, reviewer requests, the review gate). Empty: the bot whose role is `automation` (config/bots.yaml)."
  type        = string
  default     = ""
}

variable "humans" {
  description = "GitHub logins allowed to answer gates and whose approval satisfies review:human."
  type        = list(string)
  default     = []
}

variable "webhook_secret" {
  description = "The secret GitHub signs the GitHub App's webhook deliveries with. Required: `/webhooks/github` is the one path this install exposes to the internet, and the signature is the only thing that authenticates a delivery. `fleetadlc cloud configure` generates it into ~/.fleetadlc/cloud.tfvars.json; put the same value on the GitHub App's webhook. A secret the console's walkthrough stored wins over this one."
  type        = string
  sensitive   = true
}

variable "console_domain" {
  description = "The domain the console is served on, for the load balancer's managed certificate. Required: IAP needs an HTTPS load balancer, and a managed certificate needs a name to be issued for. Point an A record for it at the `console_ip` output (`fleetadlc cloud output`) once the module has applied."
  type        = string
}

variable "console_members" {
  description = "IAM members admitted to the console, as `user:someone@example.com` or `group:…`. With IAP's default, Google-managed OAuth client, Google admits only identities in the project's own Google Cloud organization, so someone from outside it (a @gmail.com account, say) is refused at sign-in; to admit them, set iap_oauth2_client_id and iap_oauth2_client_secret."
  type        = list(string)
  default     = []
}

variable "admin_emails" {
  description = "Emails that become the console's first admins, while it has no users yet. Empty: every `user:` in console_members does; if that names nobody either, nobody is admin and the console says to set this. Admins add and remove everyone else in Settings → Users."
  type        = list(string)
  default     = []
}

variable "operators" {
  description = "IAM members admitted to the terminal gateway. Keep this smaller than console_members: take-over is a shell inside a bot's computer. As with console_members, IAP's default OAuth client admits only identities in the project's own organization; see iap_oauth2_client_id."
  type        = list(string)
  default     = []
}

variable "iap_oauth2_client_id" {
  description = "An OAuth client of your own for IAP, for people outside the project's Google Cloud organization, whom Google's managed client refuses. Make it by hand in the Google Auth Platform, as a Web application client whose authorized redirect URI is https://iap.googleapis.com/v1/oauth/clientIds/<CLIENT_ID>:handleRedirect (docs/self-hosting.md). Set with iap_oauth2_client_secret, or neither. Empty: Google's managed client."
  type        = string
  default     = ""
}

variable "iap_oauth2_client_secret" {
  description = "The secret of iap_oauth2_client_id's client. Kept in cloud.tfvars.json and the state bucket, beside webhook_secret. Empty when iap_oauth2_client_id is."
  type        = string
  default     = ""
  sensitive   = true
}

# ---------------------------------------------------------------- egress

variable "extra_allowed_domains" {
  description = "Domains to add to the egress allowlist, for example your testing environment's hostname. A private package registry goes in registry_host instead, which also tells hostd about it."
  type        = list(string)
  default     = []
}

variable "registry_host" {
  description = "The bare host name of a private npm registry the repositories install from, such as npm.internal.example: no scheme, path or port. It is added to the egress allowlist and handed to hostd as FLEETADLC_REGISTRY_HOST. The token is not a variable, so it stays out of the state: store it in Secret Manager as `fleet-registry-token` after the first apply (docs/self-hosting.md). Empty: none."
  type        = string
  default     = ""

  # fleetadlc-install writes `//<host>/:_authToken` and `registry=https://<host>/`,
  # and the proxy matches `.<host>`: a scheme, a path or a port in it breaks all three.
  validation {
    condition     = var.registry_host == "" || can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.registry_host))
    error_message = "registry_host is a bare host name such as npm.internal.example, with no scheme, path or port, or empty."
  }
}

variable "notification_channels" {
  description = "Cloud Monitoring notification channels for the alerts this module creates, as projects/<project>/notificationChannels/<id>. Empty notifies nobody: a firing alert only opens an incident in the Cloud Monitoring console."
  type        = list(string)
  default     = []
}

# ---------------------------------------------------------------- deploying

variable "deployer_repository" {
  description = "A GitHub repository (owner/name) whose workflow may roll new images out to this install, through Workload Identity Federation. Spelled exactly as GitHub spells it, capitals included: the token's claim is compared as a string, and `fleetadlc cloud configure` asks GitHub for the spelling. Empty: none may."
  type        = string
  default     = ""

  validation {
    condition     = var.deployer_repository == "" || can(regex("^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$", var.deployer_repository))
    error_message = "deployer_repository is owner/name, such as exampleco/deploys, or empty."
  }
}

variable "deployer_repository_id" {
  description = "deployer_repository's numeric id, which the provider admits it by: a name is freed by a rename or a transfer, and someone else can take it. `fleetadlc cloud configure` looks it up; by hand, `gh api repos/<owner>/<name> --jq .id`. Required when deployer_repository is set."
  type        = string
  default     = ""

  validation {
    condition     = can(regex("^[0-9]*$", var.deployer_repository_id))
    error_message = "deployer_repository_id is the repository's numeric id, or empty."
  }
}

variable "deployer_repository_owner_id" {
  description = "The numeric id of deployer_repository's owner, user or organization. `fleetadlc cloud configure` looks it up; by hand, `gh api repos/<owner>/<name> --jq .owner.id`. Required when deployer_repository is set."
  type        = string
  default     = ""

  validation {
    condition     = can(regex("^[0-9]*$", var.deployer_repository_owner_id))
    error_message = "deployer_repository_owner_id is the owner's numeric id, or empty."
  }
}

variable "deployer_workflow" {
  description = "The one workflow file in deployer_repository whose runs are admitted, as a path from the repository's root. Any other workflow there, whatever starts it, is refused."
  type        = string
  default     = ".github/workflows/deploy.yml"

  validation {
    condition     = can(regex("^\\.github/workflows/[A-Za-z0-9._-]+\\.ya?ml$", var.deployer_workflow))
    error_message = "deployer_workflow is a file under .github/workflows/, such as .github/workflows/deploy.yml."
  }
}

variable "deployer_branch" {
  description = "The only branch of deployer_repository whose runs are admitted. Whoever can run deployer_workflow on it controls the install: protect it."
  type        = string
  default     = "main"

  validation {
    condition     = can(regex("^[A-Za-z0-9._/-]+$", var.deployer_branch))
    error_message = "deployer_branch is a branch name, such as main."
  }
}

variable "deployer_reads_app_key" {
  description = "Let the deployer read the install's GitHub App private key, the full key, to check out a private OpenADLC repository with a token it mints from it. Whoever holds the key can mint tokens with every permission the app has. Only once the walkthrough has made the app (the secret must exist)."
  type        = bool
  default     = false
}
