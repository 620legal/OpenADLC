# SPDX-License-Identifier: Apache-2.0 OR 0BSD

# The targets the platform calls by name. A repository missing one of these is a
# repository a task cannot set up, check or migrate — hostd runs `make setup` at
# task start for a task with a database of its own (the docker driver, a seat
# marked sidecarDb), and `make ci` when the builder runs `fleetadlc-ci` before
# opening a pull request.
#
# The four deploy targets are what the delivery workflows run, when this
# repository ships by `.github/fleetadlc.yml` (see the templates beside it).
# Until they say how, they refuse, so a deploy nobody set up fails loudly.
# Write `smoke-testing` together with `deploy-testing`: a red smoke reverts the
# change. Each workflow skips until its repository Actions variable is `true`:
# FLEETADLC_DEPLOY_TESTING for the deploy, FLEETADLC_SMOKE_TESTING for the
# smoke. Turn the smoke on only once it checks something: while it is skipped,
# a merged change waits on testing and is neither promoted nor reverted.

.PHONY: setup ci test typecheck migrate deploy-testing smoke-testing promote-production rollback-production

setup: migrate
	@echo "setup: ready"

ci: typecheck test
	@echo "ci: green"

# What is not code: the files OpenADLC writes, the docs, any Markdown file
# (a CONTRIBUTING.md at the root counted as code and failed `make ci`), the
# licence, a root .editorconfig, and git's own files at any depth (a
# repository GitHub created with a .gitignore failed `make ci` from the start).
NOT_CODE := (^(LICENSE|NOTICE|COPYING|Makefile|docs/|\.github/|\.editorconfig$$)|(^|/)\.git(ignore|attributes|keep)$$|\.md$$)

# Until there is code, there is nothing to check, and these pass saying so:
# refusing outright meant no first pull request could merge, even one that
# only touched the README. Once there is code they refuse until they are
# replaced with this repository's own, so `make ci` is never green over code
# that nothing runs: the first change that adds code adds its checks here.
test:
	@if git ls-files | grep -Ev '$(NOT_CODE)' | grep -q .; then \
	  echo "test: this repository has code and no tests: replace this target with its tests" && exit 1; \
	else echo "test: nothing to test yet (no code)"; fi

typecheck:
	@if git ls-files | grep -Ev '$(NOT_CODE)' | grep -q .; then \
	  echo "typecheck: this repository has code and no checks: replace this target with its own" && exit 1; \
	else echo "typecheck: nothing to typecheck yet (no code)"; fi

migrate:
	@echo "no migrations yet"

# The last line deploy-testing and promote-production print must be the
# deployed revision's URL: the workflows pass it to GitHub as the environment's
# URL, and OpenADLC links it on the pull request as where the change is live.
# A target that prints no URL last still ships, and the pull request says so.
deploy-testing:
	@echo "deploy-testing: say how this repository deploys $(SHA) to testing" && exit 1

smoke-testing:
	@echo "smoke-testing: say how this repository checks testing works" && exit 1

promote-production:
	@echo "promote-production: say how this repository promotes $(CANDIDATE)" && exit 1

rollback-production:
	@echo "rollback-production: say how this repository rolls production back" && exit 1
