# ---------------------------------------------------------------- deploying from GitHub Actions
# Optional. Name a repository in `deployer_repository` and one workflow file in it, `deployer_workflow`, run
# from its `deployer_branch` (main by default), can roll new images out to this install: push to the registry,
# update the two Cloud Run services, and restart hostd on the host. It signs in through Workload Identity
# Federation, so no key exists to leak (and an organization that forbids service-account keys still works). The
# workflow itself is the operator's, kept wherever they like, including a private repository; nothing here
# knows what it contains.
#
# Whoever can run that workflow on that branch controls the install: the identity can put any image under the
# bridge and reach the host as root, and both hold every secret the install keeps. Protect the branch, keep a
# person on `.github/` in that repository, and never give `id-token: write` to a workflow that runs code from
# a pull request.

locals {
  deployer = var.deployer_repository != "" ? 1 : 0
}

resource "google_project_service" "deployer" {
  for_each = var.deployer_repository != "" ? toset(["iamcredentials.googleapis.com", "sts.googleapis.com"]) : toset([])

  service            = each.key
  disable_on_destroy = false
}

resource "google_iam_workload_identity_pool" "github" {
  count                     = local.deployer
  workload_identity_pool_id = "${var.name_prefix}-github"
  display_name              = "GitHub Actions"
  depends_on                = [google_project_service.deployer]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  count                              = local.deployer
  workload_identity_pool_id          = google_iam_workload_identity_pool.github[0].workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub Actions"

  attribute_mapping = {
    "google.subject"                = "assertion.sub"
    "attribute.repository"          = "assertion.repository"
    "attribute.repository_id"       = "assertion.repository_id"
    "attribute.repository_owner_id" = "assertion.repository_owner_id"
    "attribute.ref"                 = "assertion.ref"
    "attribute.workflow_ref"        = "assertion.workflow_ref"
  }

  # One workflow file, run from `deployer_branch`, in the one repository, known by its numeric id and its
  # owner's. Matched by name alone, the provider admitted any workflow on the default branch, started by any
  # trigger that runs there (schedule, issue_comment, workflow_run, pull_request_target), and a name freed by
  # a rename or a transfer could be registered by someone else. `workflow_ref` is
  # `<owner>/<name>/<path>@<ref>`, spelled as GitHub spells the repository: `fleetadlc cloud configure` asks
  # GitHub for the spelling and the ids. The ids and the path are checked by their variables' validation
  # before they are put into this expression.
  attribute_condition = join(" && ", [
    "assertion.repository_id == '${var.deployer_repository_id}'",
    "assertion.repository_owner_id == '${var.deployer_repository_owner_id}'",
    "assertion.ref == 'refs/heads/${var.deployer_branch}'",
    "assertion.workflow_ref == '${var.deployer_repository}/${var.deployer_workflow}@refs/heads/${var.deployer_branch}'",
  ])

  lifecycle {
    precondition {
      condition     = var.deployer_repository_id != "" && var.deployer_repository_owner_id != ""
      error_message = "deployer_repository is set, so deployer_repository_id and deployer_repository_owner_id must be too: the provider admits the repository by its ids. Run fleetadlc cloud configure, or: gh api repos/${var.deployer_repository} --jq '.id, .owner.id'"
    }
  }

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "deployer" {
  count        = local.deployer
  account_id   = "${var.name_prefix}-deployer"
  display_name = "OpenADLC deployer (GitHub Actions: ${var.deployer_repository})"
}

resource "google_service_account_iam_member" "deployer_federation" {
  count              = local.deployer
  service_account_id = google_service_account.deployer[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github[0].name}/attribute.repository_id/${var.deployer_repository_id}"
}

# What a rollout needs: push images, move the two services onto them (as the identity they already run as),
# and reach the host over IAP to restart hostd. That is the whole install, not a narrow slice of it: an image
# the bridge runs reads every secret the bridge can, osAdminLogin is root on the host, whose account
# administers every secret in the project, and with `deployer_reads_app_key` the deployer is handed
# the full GitHub App private key besides. Narrowing run.developer and osAdminLogin to the two services and the one
# instance, or requiring a GitHub environment with a reviewer, is further hardening left to the operator.
resource "google_project_iam_member" "deployer" {
  for_each = var.deployer_repository != "" ? toset([
    "roles/artifactregistry.writer",
    "roles/run.developer",
    "roles/compute.viewer",
    "roles/compute.osAdminLogin",
    "roles/iap.tunnelResourceAccessor",
  ]) : toset([])

  project = var.project_id
  role    = each.key
  member  = "serviceAccount:${google_service_account.deployer[0].email}"
}

# Every identity a service runs as: a rollout moves a service onto a new image as
# its own account, and without actAs on that account the rollout is refused.
resource "google_service_account_iam_member" "deployer_acts_as" {
  for_each = var.deployer_repository != "" ? {
    bridge  = google_service_account.bridge.name
    console = google_service_account.console.name
    host    = google_service_account.host.name
  } : {}

  service_account_id = each.value
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer[0].email}"
}

# Optional. The deploy workflow has to check the fleet source out, and a private OpenADLC repository admits
# nobody by default. With this on, the deployer reads the install's GitHub App private key itself, the full
# key (which the bridge keeps in Secret Manager once the walkthrough has made the app), and mints a token
# from it, so no personal token or deploy key has to be made for it. The key is the app's: whoever holds it
# can mint a token with every permission the app has, on every repository it is installed on, not only a
# read-only one.
resource "google_secret_manager_secret_iam_member" "deployer_app_key" {
  count   = var.deployer_repository != "" && var.deployer_reads_app_key ? 1 : 0
  project = var.project_id
  # The bridge names every secret `fleet-<ref>` (GcpSecretStore), whatever the prefix; the
  # name predates FleetADLC and is kept so existing secrets stay where they are.
  secret_id = "fleet-github-app-private-key"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.deployer[0].email}"
}
