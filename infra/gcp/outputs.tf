output "console_url" {
  description = "Where a person opens the board. Not the Cloud Run URL: that answers only the load balancer now, and IAP is on the load balancer."
  value       = "https://${var.console_domain}"
}

output "console_ip" {
  description = "Point an A record for console_domain here. The managed certificate is not issued until that record resolves, and IAP is not in front of anything until the certificate is issued."
  value       = google_compute_global_address.console.address
}

output "bridge_url" {
  description = "The event loop and the console API, on the internal Cloud Run URL. Not reachable from the internet, and not where the webhook goes — see webhook_url."
  value       = google_cloud_run_v2_service.bridge.uri
}

output "webhook_url" {
  description = "The exact URL for the OpenADLC GitHub App's webhook. Through the load balancer, because the bridge's own Cloud Run URL admits nothing from the internet and GitHub is on the internet."
  value       = "https://${var.console_domain}/webhooks/github"
}

output "host_internal_ip" {
  description = "The host's address inside the VPC. It has no external address by design."
  value       = google_compute_instance.host.network_interface[0].network_ip
}

output "host_name" {
  value = google_compute_instance.host.name
}

# What the host runs on, as one value: its cloud-init, and the versions of the
# database URL and of the CA that URL checks the server against.
# Container-Optimized OS applies cloud-init at boot, and hostd reads the URL
# only when it starts, so a host that was merely restarted ran the old prepare
# script against the new URL. `fleetadlc cloud apply` resets the host when this
# changed. A hash, and no secret in it: the password is never in the cloud-init.
output "host_rollout" {
  description = "Changes whenever the host's cloud-init, the database URL or the database's CA changes. `fleetadlc cloud apply` resets the host when it does, so cloud-init and hostd start again on the new ones."
  value       = sha256("${local.host_cloud_init}|${google_secret_manager_secret_version.database_url.version}|${google_secret_manager_secret_version.database_ca.version}")
}

output "database_connection_name" {
  value = google_sql_database_instance.fleet.connection_name
}

output "database_private_ip" {
  value = google_sql_database_instance.fleet.private_ip_address
}

output "host_service_account" {
  description = "The identity that reads the per-bot refresh tokens and signing keys."
  value       = google_service_account.host.email
}

output "next_steps" {
  description = "What is left to do by hand, because GitHub needs a person at a browser."
  value       = <<-EOT
    1. Point an A record for ${var.console_domain} at:
         ${google_compute_global_address.console.address}
       Nothing else works until this resolves: the managed certificate is issued
       against that record, and until it is, IAP is in front of nothing.
    2. Connect the bots' GitHub accounts in the console's walkthrough, at its
       GitHub accounts step:
         https://${var.console_domain}
       GitHub needs a person at a browser for each sign-in, and the refresh
       tokens belong in this install's Secret Manager, not in Terraform state.
       Moving an install here? Restore its backup in the walkthrough's first
       step instead, taking over its sign-ins.
    3. An app created from the console already delivers to
         https://${var.console_domain}/webhooks/github
       with the secret the console stored: leave its webhook alone. After a
       restore, or for an app made by hand, use the console's webhook step,
       which sets one secret on both sides. Only for an app made by hand on a
       fresh install, point its webhook there on the app's settings page, with
       `webhook_secret` from ~/.fleetadlc/cloud.tfvars.json (also kept in the
       state bucket) as its secret. The console's webhook card shows whether a
       delivery arrived.
    4. Check the install on the console's health cards and its walkthrough,
       which say what is left and where it is done:
         https://${var.console_domain}
    The host runs no fleetadlc command: everything above is in the console.
  EOT
}

output "deployer_workload_identity_provider" {
  description = "For google-github-actions/auth's workload_identity_provider, when deployer_repository is set."
  value       = var.deployer_repository != "" ? google_iam_workload_identity_pool_provider.github[0].name : null
}

output "deployer_service_account" {
  description = "For google-github-actions/auth's service_account, when deployer_repository is set."
  value       = var.deployer_repository != "" ? google_service_account.deployer[0].email : null
}
