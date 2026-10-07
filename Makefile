# What a task runs. The implement skill tells a bot to get `make ci` green before
# it opens a pull request, and hostd runs `make setup` against the task's own
# database when a task starts — so these targets are the contract between the
# platform and a repository it works in, not a convenience for people.
#
# A repository OpenADLC manages should provide the same four (setup, ci, test
# and migrate), whatever they wrap; crew/templates/repo/Makefile is a starting
# point.

.PHONY: setup ci test typecheck build migrate clean \
	deploy-testing smoke-testing deploy-production smoke-production \
	shift-traffic rollback-production

## setup: bring a fresh checkout to the point where `make ci` can run.
setup:
	pnpm install --frozen-lockfile
	pnpm build
	$(MAKE) migrate

## ci: everything that has to be true before a pull request is opened.
ci: typecheck test
	@echo "ci: green"

test:
	pnpm test

typecheck:
	pnpm typecheck

build:
	pnpm build

## migrate: apply migrations to DATABASE_URL, which hostd points at the task's
## own database. Skipped without one rather than falling back to a default,
## because the default would be somebody else's database.
migrate:
	@if [ -z "$$DATABASE_URL" ]; then \
		echo "migrate: no DATABASE_URL; skipping"; \
	else \
		node packages/db/dist/cli/migrate.js; \
	fi

clean:
	rm -rf apps/*/dist packages/*/dist apps/console/.next

# ---------------------------------------------------------------- the deploy path
#
# The workflows in `.github/workflows/deploy-*.yml`, `smoke-*.yml`,
# `promote-production.yml` and `rollback-production.yml` call these, and build
# and migrate above, and run no deploy commands of their own, so how a
# repository deploys stays in the repository. Each one's stdout
# is its answer, and the workflow reads the last line (or last two).
#
# OpenADLC's own install has no hosted testing or production environment yet, so
# every target below stops and says what to put there. That is why
# `FLEETADLC_DEPLOY_TESTING` is unset on this repository and `deploy-testing` skips:
# a green deploy of nothing would label a pull request as live somewhere it is
# not, and the dependency logic reads that label.

define no_target
	@echo "$(1): this repository has no $(2) target."; \
	echo; \
	echo "Replace this target with whatever deploys it — a gcloud run deploy, a"; \
	echo "helm upgrade, an ssh — and $(3)"; \
	echo; \
	echo "See docs/self-hosting.md, 'The deploy path'."; \
	exit 1
endef

## deploy-testing: deploy HEAD to testing. Last line of output: the revision URL.
deploy-testing:
	$(call no_target,deploy-testing,testing,print the new revision's URL as the last line.)

## smoke-testing: exercise the testing environment. Non-zero means revert.
smoke-testing:
	$(call no_target,smoke-testing,testing,exit non-zero when the environment is not working.)

## deploy-production: deploy HEAD to production serving no traffic.
## Last two lines of output: the revision's tag, then its URL.
deploy-production:
	$(call no_target,deploy-production,production,print the revision tag then its URL as the last two lines.)

## smoke-production: exercise the revision in FLEETADLC_REVISION_TAG, not whatever
## is currently serving.
smoke-production:
	$(call no_target,smoke-production,production,exit non-zero when FLEETADLC_REVISION_TAG is not working.)

## shift-traffic: send production traffic to FLEETADLC_REVISION_TAG.
shift-traffic:
	$(call no_target,shift-traffic,production,move all traffic to FLEETADLC_REVISION_TAG.)

## rollback-production: send traffic back to FLEETADLC_REVISION_TAG, or to whatever
## was serving before the last shift when it is empty. Never migrates.
rollback-production:
	$(call no_target,rollback-production,production,move traffic back and print what is serving now.)
