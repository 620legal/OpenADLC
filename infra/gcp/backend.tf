# The state lives in a bucket in the install's own project, named by `openadlc cloud configure` and passed at
# init (`-backend-config`), so nothing about any one install is written in this repository. Beside the state
# sit the install's settings (`cloud.tfvars.json`), which is how another machine takes over with
# `openadlc cloud pull`.
terraform {
  backend "gcs" {}
}
