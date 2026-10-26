import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_REPOSITORY, RELEASE_IMAGES, releaseImageName } from '@openadlc/shared';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * What `terraform validate` cannot tell you.
 *
 * `validate` checks that the configuration is well-formed: types line up, every
 * referenced variable exists, every block has the arguments its schema requires.
 * It has no opinion about whether the thing described will work. A module whose
 * firewall denies the only caller that matters validates cleanly, and so does
 * one whose IAP binding points at a resource that was never created.
 *
 * So this file asserts the things a reader would otherwise have to hold in their
 * head across four hundred lines: that each caller the comments promise has a
 * rule, and that the rules do not overlap into each other's business.
 *
 * It is not a substitute for `terraform plan` against a real project, which
 * needs credentials this repository does not have. `docs/unverified.md` records
 * what that would prove.
 */
const MODULE = join(dirname(fileURLToPath(import.meta.url)), '..', 'infra', 'gcp');
const mainTf = readFileSync(join(MODULE, 'main.tf'), 'utf8');
const outputsTf = readFileSync(join(MODULE, 'outputs.tf'), 'utf8');
const variablesTf = readFileSync(join(MODULE, 'variables.tf'), 'utf8');
const deployerTf = readFileSync(join(MODULE, 'deployer.tf'), 'utf8');
const cloudInit = readFileSync(join(MODULE, 'cloud-init', 'host.yaml'), 'utf8');

/** Every `resource "<type>" "<name>"` in the module, as `type.name`. */
const declared = new Set(
  [...mainTf.matchAll(/^resource "([^"]+)" "([^"]+)"/gm)].map((m) => `${m[1]}.${m[2]}`),
);

/** The body of a top-level `resource "<type>" "<name>" { … }`, braces matched. */
function resourceBlock(type: string, name: string, file = mainTf): string | null {
  const header = `resource "${type}" "${name}" {`;
  const start = file.indexOf(header);
  if (start < 0) return null;

  let depth = 0;
  for (let i = start + header.length - 1; i < file.length; i += 1) {
    if (file[i] === '{') depth += 1;
    if (file[i] === '}') {
      depth -= 1;
      if (depth === 0) return withoutComments(file.slice(start + header.length, i));
    }
  }
  return null;
}

/**
 * Comments are dropped before anything is matched. A test that a comment can
 * break is a test that discourages writing them, and the comment explaining why
 * `INGRESS_TRAFFIC_ALL` is wrong would otherwise fail the assertion that
 * `INGRESS_TRAFFIC_ALL` is absent.
 */
function withoutComments(block: string): string {
  return block
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

/** The value an `env { name = "<name>" value = … }` block in `block` gives, as written. */
function envValue(block: string, name: string): string | undefined {
  return new RegExp(`env \\{\\s*name\\s*=\\s*"${name}"\\s*value\\s*=\\s*(.+)\\s*\\}`).exec(block)?.[1]?.trim();
}

/**
 * What cloud-init writes at `path`, as the host gets it: the `content: |`
 * block, its indent taken off. The block ends, as YAML ends it, at the first
 * line indented less than it, which is the comment above the next file.
 */
function writtenFile(path: string): string {
  const start = cloudInit.indexOf(`- path: ${path}\n`);
  if (start < 0) return '';
  const lines = cloudInit.slice(cloudInit.indexOf('content: |\n', start) + 'content: |\n'.length).split('\n');
  const end = lines.findIndex((line) => line.trim() !== '' && !line.startsWith('      '));
  return `${(end < 0 ? lines : lines.slice(0, end))
    .map((line) => line.slice(6))
    .join('\n')
    .trimEnd()}\n`;
}

/** Terraform's templatefile, for the names given: `${name}` is the value, `$${` a literal `${`. */
function rendered(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [name, value] of Object.entries(values)) out = out.split(`\${${name}}`).join(value);
  const left = /(?<!\$)\$\{([a-z_]+)\}/.exec(out);
  if (left) throw new Error(`the template reads \${${left[1]}}, which this test does not give`);
  return out.split('$${').join('${');
}

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const MIRROR = 'us-central1-docker.pkg.dev/acme-openadlc/openadlc-ghcr';
const HOSTD_RELEASE = `${MIRROR}/620legal/openadlc/service`;
const digest = (hex: string) => `sha256:${hex.repeat(64 / hex.length)}`;

/**
 * One start of `openadlc-hostd`'s image step (`/etc/openadlc/hostd-image.sh`), run
 * for real by bash against a scratch directory in place of /var/lib/openadlc and
 * /run/openadlc, with a docker that has `present` and fails to pull `unpullable`,
 * and `hostdImage` as the module's hostd_image.
 */
function hostStart(
  written: string | undefined,
  docker: { present?: string[]; unpullable?: string[]; hostdImage?: string; started?: string } = {},
): { status: number | null; said: string; hostd: string | null; docker: string[]; chowned: string[]; file: { text: string; mode: number } | null } {
  const work = mkdtempSync(join(tmpdir(), 'openadlc-host-images-'));
  scratch.push(work);
  const root = join(work, 'var-lib-openadlc');
  const run = join(work, 'run-openadlc');
  const bin = join(work, 'bin');
  mkdirSync(root, { recursive: true });
  mkdirSync(bin);
  if (written !== undefined) writeFileSync(join(root, 'hostd-image'), written);
  if (docker.started !== undefined) writeFileSync(join(root, 'hostd-image.started'), docker.started);
  const log = join(work, 'docker.log');
  const present = join(work, 'present');
  const unpullable = join(work, 'unpullable');
  writeFileSync(log, '');
  writeFileSync(present, (docker.present ?? []).map((image) => `${image}\n`).join(''));
  writeFileSync(unpullable, (docker.unpullable ?? []).map((image) => `${image}\n`).join(''));
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub(
    'docker',
    `echo "$*" >> '${log}'
case "$1" in
  image) [ "$2" = inspect ] && grep -qxF -- "$3" '${present}' ;;
  pull) if grep -qxF -- "$2" '${unpullable}'; then echo "pull $2: not found" >&2; exit 1; fi; echo "$2" >> '${present}' ;;
  *) exit 2 ;;
esac`,
  );
  stub('chown', `echo "$*" >> '${join(work, 'chown.log')}'`);
  const script = rendered(writtenFile('/etc/openadlc/hostd-image.sh'), {
    hostd_release_image: HOSTD_RELEASE,
    hostd_image: docker.hostdImage ?? 'registry/hostd:latest',
  })
    .split('/var/lib/openadlc')
    .join(root)
    .split('/run/openadlc')
    .join(run);
  writeFileSync(join(work, 'hostd-image.sh'), script);
  const started = spawnSync('bash', [join(work, 'hostd-image.sh')], {
    env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` },
    encoding: 'utf8',
  });
  const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8').trim() : null);
  return {
    status: started.status,
    said: `${started.stdout}${started.stderr}`,
    hostd: read(join(run, 'running-hostd-image')),
    docker: readFileSync(log, 'utf8').split('\n').filter(Boolean),
    chowned: (read(join(work, 'chown.log')) ?? '').split('\n').filter(Boolean),
    file: existsSync(join(root, 'hostd-image')) ? { text: readFileSync(join(root, 'hostd-image'), 'utf8'), mode: statSync(join(root, 'hostd-image')).mode & 0o777 } : null,
  };
}

/**
 * The egress allowlist's own domains, and nothing else in main.tf: the
 * enabled-API list is quoted domains too, and read along with it, a host the
 * proxy refuses passed for one it allows.
 */
const egressList = mainTf.slice(
  mainTf.indexOf('allowed_egress_domains = concat('),
  mainTf.indexOf('var.extra_allowed_domains', mainTf.indexOf('allowed_egress_domains = concat(')),
);
const egressDomains = [...egressList.matchAll(/^\s+"([a-z0-9.-]+\.[a-z]+)",?$/gm)].map((match) => match[1]!);

const iap = resourceBlock('google_compute_firewall', 'from_iap');
const bridge = resourceBlock('google_compute_firewall', 'from_bridge');

describe('who is allowed to reach the host', () => {
  it('lets the bridge reach hostd, or no task can ever start', () => {
    // The bug: the module allowed IAP's range and denied everything else,
    // including the subnet the bridge's VPC interface sits on. Every `POST
    // /tasks` from the bridge would have been dropped by the firewall.
    expect(bridge).not.toBeNull();
    expect(bridge).toContain('var.subnet_cidr');
    expect(bridge).toContain('tostring(var.hostd_port)');
    expect(bridge).toContain('direction = "INGRESS"');
  });

  it('does not give the bridge the host’s shell as well', () => {
    // hostd's API is the whole of what the bridge needs. Port 22 from the same
    // range would hand a compromised bridge the host itself.
    expect(bridge).not.toContain('"22"');
  });

  it('keeps IAP’s access, which is how a person takes a session over', () => {
    expect(iap).toContain('35.235.240.0/20');
    expect(iap).toContain('tostring(var.hostd_port)');
    expect(iap).toContain('"22"');
  });

  it('does not open hostd to the internet from either rule', () => {
    // `0.0.0.0/0` belongs in the deny and nowhere else.
    expect(iap).not.toContain('0.0.0.0/0');
    expect(bridge).not.toContain('0.0.0.0/0');
  });

  it('still denies everything else', () => {
    const deny = resourceBlock('google_compute_firewall', 'deny_other_ingress');
    expect(deny).toContain('0.0.0.0/0');
    expect(deny).toContain('deny {');
  });

  it('applies every rule to the host and nothing else', () => {
    // An untagged rule is a rule against the whole network.
    const rules = [...declared].filter((resource) => resource.startsWith('google_compute_firewall.'));
    expect(rules.length).toBeGreaterThan(2);
    for (const rule of rules) {
      const block = resourceBlock('google_compute_firewall', rule.slice('google_compute_firewall.'.length));
      expect(block, rule).toMatch(/target_tags\s*=\s*\["openadlc-host"\]/);
    }
  });
});

describe('what IAP is actually in front of', () => {
  const consoleBinding = resourceBlock('google_iap_web_backend_service_iam_binding', 'console');
  const terminalBinding = resourceBlock('google_iap_web_backend_service_iam_binding', 'terminal');

  it('names a backend service that exists', () => {
    // The bug, and the reason this file exists: the binding named
    // `google_cloud_run_v2_service.console.name`. A Cloud Run service is not a
    // compute backend service, the module created none, and `terraform
    // validate` was perfectly happy — IAP was in front of nothing at all.
    for (const binding of [consoleBinding, terminalBinding]) {
      const match = /web_backend_service = ([\w.]+)\.name/.exec(binding ?? '');
      expect(match?.[1]).toBeDefined();
      expect(declared.has(match![1]!)).toBe(true);
      expect(match![1]).toMatch(/^google_compute_backend_service\./);
    }
  });

  it('has something for a request to arrive on', () => {
    // A backend service with no URL map, proxy or forwarding rule in front of it
    // is not reachable, and IAP on it protects nothing.
    for (const resource of [
      'google_compute_url_map.console',
      'google_compute_target_https_proxy.console',
      'google_compute_global_forwarding_rule.console',
      'google_compute_managed_ssl_certificate.console',
      'google_compute_global_address.console',
    ]) {
      expect(declared.has(resource)).toBe(true);
    }
  });

  it('admits the operators to the terminal and the wider list to the console', () => {
    // `var.operators` was declared and never referenced, so take-over had no
    // restriction at all despite the comment above the binding saying it did.
    expect(terminalBinding).toContain('var.operators');
    expect(consoleBinding).toContain('var.console_members');
    // Not the other way round: a shell inside a bot's computer is not for
    // everyone who may read the board.
    expect(terminalBinding).not.toContain('var.console_members');
  });

  it('routes /terminal to its own backend, or one binding covers both', () => {
    const urlMap = resourceBlock('google_compute_url_map', 'console');
    expect(urlMap).toContain('/terminal');
    expect(urlMap).toContain('google_compute_backend_service.terminal.id');
  });

  it('cannot be switched off, on the console, the terminal or the bridge', () => {
    // A variable used to turn IAP off. That left the load balancer answering
    // anyone on the internet and the bridge in local mode, where every name it
    // did not know was an admin: a backup holding every credential was a
    // request away.
    // The only IAP variables are the OAuth client's, which switch nothing off.
    expect([...variablesTf.matchAll(/variable "(\w*iap\w*)"/g)].map((m) => m[1])).toEqual([
      'iap_oauth2_client_id',
      'iap_oauth2_client_secret',
    ]);
    for (const name of ['console', 'terminal']) {
      const backend = resourceBlock('google_compute_backend_service', name) ?? '';
      expect(backend, name).toMatch(/iap \{\s*enabled\s*=\s*true\s/);
      expect(resourceBlock('google_iap_web_backend_service_iam_binding', name), name).not.toContain('count');
    }
    const bridge = resourceBlock('google_cloud_run_v2_service', 'bridge') ?? '';
    expect(/name\s*=\s*"OPENADLC_IDENTITY_MODE"\s*\n\s*value\s*=\s*(.+)/.exec(bridge)?.[1]?.trim()).toBe('"iap"');
    const console = resourceBlock('google_cloud_run_v2_service', 'console') ?? '';
    expect(/name\s*=\s*"OPENADLC_IDENTITY_MODE_EXPECTED"\s*\n\s*value\s*=\s*(.+)/.exec(console)?.[1]?.trim()).toBe('"iap"');
  });

  it('takes an OAuth client of the operator’s own on both backends, for people outside the organization', () => {
    // Google's managed client admits only the project's organization, so a
    // @gmail.com collaborator in console_members was refused at sign-in, and
    // the module had no way to name another client.
    for (const name of ['console', 'terminal']) {
      const block = /iap \{[^}]*\}/.exec(resourceBlock('google_compute_backend_service', name) ?? '')?.[0] ?? '';
      expect(block, name).toMatch(/oauth2_client_id\s*=\s*var\.iap_oauth2_client_id != "" \? var\.iap_oauth2_client_id : null/);
      expect(block, name).toMatch(/oauth2_client_secret\s*=\s*var\.iap_oauth2_client_secret != "" \? var\.iap_oauth2_client_secret : null/);
    }
    const secret = /variable "iap_oauth2_client_secret" \{[\s\S]*?\n\}/.exec(variablesTf)?.[0] ?? '';
    expect(secret).toMatch(/sensitive\s*=\s*true/);
    expect(variablesTf).toMatch(/variable "iap_oauth2_client_id" \{[^}]*default\s*=\s*""/);
    // Both or neither, refused at plan time.
    expect(resourceBlock('google_compute_backend_service', 'console')).toMatch(
      /precondition \{\s*condition\s*=\s*\(var\.iap_oauth2_client_id == ""\) == \(var\.iap_oauth2_client_secret == ""\)\s*error_message\s*=\s*"[^"]*iap_oauth2_client_id[^"]*iap_oauth2_client_secret/,
    );
  });

  it('tells whoever lists the members that the default client admits only the organization', () => {
    for (const name of ['console_members', 'operators']) {
      const variable = new RegExp(`variable "${name}" \\{[\\s\\S]*?\\n\\}`).exec(variablesTf)?.[0] ?? '';
      expect(variable, name).toContain('organization');
      expect(variable, name).toContain('iap_oauth2_client_id');
    }
  });

  it('moves the resources that were named fleet, rather than destroying the network and the database to make them again', () => {
    const renamed = [
      'google_compute_network',
      'google_compute_subnetwork',
      'google_compute_router',
      'google_compute_router_nat',
      'google_sql_database_instance',
      'google_sql_database',
      'google_sql_user',
    ];
    for (const type of renamed) {
      expect(resourceBlock(type, 'openadlc'), type).not.toBeNull();
      expect(resourceBlock(type, 'fleet'), type).toBeNull();
      expect(mainTf, type).toMatch(new RegExp(`moved \\{\\s*from = ${type}\\.fleet\\s*to   = ${type}\\.openadlc\\s*\\}`));
    }
    // And nothing refers to an address only the moved blocks still name.
    const withoutMoves = mainTf.replace(/moved \{[^}]*\}/g, '');
    for (const file of [withoutMoves, outputsTf]) expect(file).not.toMatch(/\bgoogle_[a-z_]+\.fleet\b/);
  });

  it('moves the bindings that had a count, rather than making them again and admitting nobody between', () => {
    for (const name of ['console', 'terminal']) {
      const address = `google_iap_web_backend_service_iam_binding.${name}`;
      expect(mainTf).toMatch(new RegExp(`moved \\{\\s*from = ${address.replace(/\./g, '\\.')}\\[0\\]\\s*to   = ${address.replace(/\./g, '\\.')}\\s*\\}`));
    }
  });

  it('holds a take-over socket open longer than a default timeout', () => {
    // 30 seconds is the default and a person at a shell is not finished in 30
    // seconds. A cut socket looks like the gateway is broken.
    const terminal = resourceBlock('google_compute_backend_service', 'terminal');
    const timeout = /timeout_sec = (\d+)/.exec(terminal ?? '');
    expect(Number(timeout?.[1])).toBeGreaterThanOrEqual(600);
  });
});

describe('who may invoke the services', () => {
  it('turns the invoker check off on both, rather than binding `allUsers`', () => {
    // Neither service had an invoker binding, so nothing could call either;
    // then both got `allUsers`, which an organization restricted to its own
    // domain refuses at apply time. `invoker_iam_disabled` is the same opening
    // without the member the policy forbids.
    expect(declared.has('google_cloud_run_v2_service_iam_binding.console_invoker')).toBe(false);
    expect(declared.has('google_cloud_run_v2_service_iam_binding.bridge_invoker')).toBe(false);
    expect(mainTf).not.toContain('"allUsers"');
    for (const name of ['console', 'bridge']) {
      expect(resourceBlock('google_cloud_run_v2_service', name)).toContain('invoker_iam_disabled = true');
    }
  });

  it('keeps the console reachable only through the load balancer', () => {
    // With no invoker check, the console is only safe because its ingress
    // admits the load balancer alone and IAP is on the load balancer. If the
    // ingress ever widens, the console is open.
    const console = resourceBlock('google_cloud_run_v2_service', 'console');
    expect(console).toContain('INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER');
    expect(console).not.toContain('INGRESS_TRAFFIC_ALL');
  });

  it('reads who is asking from IAP’s signature on the bridge, not from a header', () => {
    const bridge = resourceBlock('google_cloud_run_v2_service', 'bridge');
    expect(bridge).toContain('OPENADLC_IDENTITY_MODE');
    expect(bridge).toContain('OPENADLC_IAP_AUDIENCE');
    expect(bridge).toContain('google_compute_backend_service.console.generated_id');
  });
});

describe('what the operator is told to do', () => {
  it('points them at the load balancer, not at the Cloud Run URL', () => {
    // The Cloud Run URL stopped answering when its ingress was restricted, so
    // an output naming it would send an operator somewhere that refuses them.
    expect(outputsTf).toContain('https://${local.console_domain}');
    expect(outputsTf).toContain('google_compute_global_address.console.address');
  });

  it('sends them to the console, not to a openadlc the host does not have', () => {
    // The host runs Container-Optimized OS: no Node, no openadlc. Run from a
    // laptop instead, auth login cannot write the install's secret store and
    // doctor probes 127.0.0.1.
    const steps = /output "next_steps" \{[\s\S]*?<<-EOT([\s\S]*?)EOT/.exec(outputsTf)?.[1] ?? '';
    expect(steps).not.toMatch(/openadlc (auth login|doctor|github check|restore)/);
    const words = steps.replace(/\s+/g, ' ');
    expect(words).toContain('GitHub accounts step');
    expect(words).toContain('health cards');
    expect(words).toContain('webhook card shows whether a delivery arrived');
  });
});

describe('an install configured with nothing but who may open the console', () => {
  it('serves the console on the install’s own address under nip.io until a domain is set', () => {
    // console_domain was required, so a first-time install blocked on a DNS
    // decision twice: once at configure, and again after the apply, with the
    // certificate unissued and IAP in front of nothing until a record resolved.
    expect(variablesTf).toMatch(/variable "console_domain" \{[^}]*default\s*=\s*""/);
    expect(mainTf).toContain(
      'console_domain = var.console_domain != "" ? var.console_domain : "${google_compute_global_address.console.address}.nip.io"',
    );
  });

  it('reads the settled name everywhere, so the default reaches the certificate, the URL map and every service', () => {
    // One resource reading var.console_domain directly would get "" and, for
    // the certificate, fail the apply the default exists for.
    const direct = withoutComments(mainTf)
      .split('\n')
      .filter((line) => line.includes('var.console_domain') && !line.trimStart().startsWith('console_domain = var.console_domain != ""'));
    expect(direct).toEqual([]);
    expect(resourceBlock('google_compute_managed_ssl_certificate', 'console')).toContain('local.console_domain');
    expect(resourceBlock('google_compute_url_map', 'console')).toContain('local.console_domain');
  });

  it('tells the operator to make a DNS record only when the domain is theirs', () => {
    // The next_steps output decides by the variable: the nip.io default needs
    // no record of the operator's.
    expect(outputsTf).toMatch(/%\{~?\s*if var\.console_domain != ""\s*~?\}/);
    expect(outputsTf).toContain('nip.io');
  });

  it('leaves the GitHub organization and app to the console’s walkthrough', () => {
    // Both were required at configure time, yet onboarding collects the
    // organization and creates the app, and the bridge prefers what it stored
    // (apps/bridge/src/effective-config.ts) over these seeds.
    expect(variablesTf).toMatch(/variable "github_organization" \{[^}]*default\s*=\s*""/);
    expect(variablesTf).toMatch(/variable "github_app_client_id" \{[^}]*default\s*=\s*""/);
  });
});

describe('how GitHub reaches the bridge', () => {
  const urlMap = resourceBlock('google_compute_url_map', 'console');
  const webhook = resourceBlock('google_compute_backend_service', 'webhook');
  const bridge = resourceBlock('google_cloud_run_v2_service', 'bridge');

  it('has a public path at all', () => {
    // The bug: the bridge was deployed with an internal-load-balancer ingress,
    // the module created no load balancer, and the output told the operator to
    // point a webhook at the Cloud Run URL. Nothing GitHub sent
    // could arrive, and the symptom is a board that simply stays empty.
    expect(declared.has('google_compute_backend_service.webhook')).toBe(true);
    expect(urlMap).toContain('/webhooks/github');
    expect(urlMap).toContain('google_compute_backend_service.webhook.id');
  });

  it('exposes that path and not the rest of the bridge', () => {
    // No wildcard. Everything else on the service is the console's API and has
    // no business answering the internet.
    expect(urlMap).not.toContain('/webhooks/*');
    expect(urlMap).not.toContain('"/*"');
  });

  it('does not put IAP in front of GitHub, which cannot sign in to it', () => {
    expect(webhook).not.toContain('iap {');
  });

  it('keeps the three things that contain the public bridge', () => {
    // A bridge with no invoker check is only tolerable because of all three of
    // these at once. If this test fails, one of them was removed and the
    // bridge's whole API is an open door.
    expect(bridge).toContain('invoker_iam_disabled = true');
    expect(bridge).toContain('INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER');
    expect(urlMap).toContain('/webhooks/github');
    expect(bridge).toContain('OPENADLC_WEBHOOK_SECRET');
  });

  it('wires the webhook secret, rather than leaving verification off', () => {
    // An unset OPENADLC_WEBHOOK_SECRET makes the bridge refuse every delivery.
    // On a public path that means GitHub cannot reach a working install. It
    // used to mean the bridge ran whatever was posted to it.
    expect(declared.has('google_secret_manager_secret.webhook')).toBe(true);
    expect(bridge).toContain('secret_key_ref');
  });

  it('does not put the secret in the service definition in the clear', () => {
    // `value = var.webhook_secret` would be readable by anyone who can describe
    // the service.
    expect(bridge).not.toContain('value = var.webhook_secret');
  });

  it('names the GitHub App’s webhook, not an organization webhook, and the secret configure generated', () => {
    // An organization webhook signed with the module's secret is refused once
    // the console's walkthrough has stored the app's own, or doubles every
    // delivery.
    for (const text of [outputsTf, variablesTf, mainTf]) expect(text).not.toMatch(/organization webhook/i);
    expect(outputsTf).toContain("GitHub App's webhook");
    expect(outputsTf).not.toContain('the same secret you put in');
    expect(outputsTf).toContain('cloud.tfvars.json');
  });

  it('tells the operator a URL that works', () => {
    // The old output named the internal Cloud Run URL, so an operator following
    // it configured a webhook that could never be delivered.
    expect(outputsTf).toContain('https://${local.console_domain}/webhooks/github');
  });
});

describe('the egress allowlist the security model promises', () => {
  it('ships a cloud-init, so a default install starts anything at all', () => {
    // `host_cloud_init` defaulted to the empty string and the host's metadata
    // took it verbatim. A default cloud install therefore started no hostd, no
    // Ops Agent and no proxy — the VM came up and did nothing.
    expect(mainTf).toContain('templatefile(');
    expect(mainTf).toContain('cloud-init/host.yaml');
    expect(mainTf).toMatch(/user-data\s+=\s+local\.host_cloud_init/);
    expect(variablesTf).toContain('variable "host_cloud_init"');
  });

  it('starts the proxy, the firewall and hostd, in that order', () => {
    // hostd must not be accepting tasks before the thing that confines them is
    // up, so the units are ordered rather than merely all enabled.
    for (const unit of ['openadlc-egress-proxy.service', 'openadlc-egress-firewall.service', 'openadlc-hostd.service']) {
      expect(cloudInit).toContain(`systemctl enable --now ${unit}`);
    }
    expect(cloudInit).toContain('Requires=openadlc-egress-proxy.service');
    expect(cloudInit).toContain('Requires=openadlc-egress-firewall.service');
  });

  it('turns on the host’s log agent, without which a denial is invisible', () => {
    // Container-Optimized OS has no Ops Agent package; its own agent is turned
    // on by metadata, and the old install line failed on every boot.
    expect(mainTf).toMatch(/google-logging-enabled\s+=\s+"true"/);
    expect(cloudInit).not.toContain('google-cloud-ops-agent');
  });

  it('keeps the bots away from the metadata server’s tokens and out of the VPC', () => {
    // The host's service account reads every secret the install holds. A bot
    // that could ask the metadata server for its token would hold every other
    // bot's GitHub credential.
    expect(cloudInit).not.toContain('-d 169.254.169.254/32 -j RETURN');
    expect(cloudInit).toContain('-d 169.254.169.254/32 -p udp --dport 53 -j RETURN');
    expect(cloudInit).not.toContain('-d 10.0.0.0/8 -j RETURN');
  });

  it('admits a task to the task database server on the host’s gateway, and nothing else on that port', () => {
    // Container-Optimized OS drops INPUT by default; hostd publishes the
    // server on the docker bridge's gateway only, so a task on the
    // openadlc-tasks bridge has to be let in from a docker bridge, and from
    // nowhere else.
    expect(cloudInit).toContain('iptables -I INPUT 1 -i br+ -p tcp --dport 47433 -j ACCEPT');
    expect(cloudInit).not.toMatch(/iptables -I INPUT 1 -p tcp --dport 47433/);
  });

  it('hooks the egress chain where Docker cannot put its own rules ahead of it', () => {
    // Inserted at the top of FORWARD, it ended up behind Docker's ACCEPTs once
    // the daemon built its chains, and a bot went straight out.
    expect(cloudInit).toContain('iptables -I DOCKER-USER 1 -i br+ -j OPENADLC_EGRESS');
    expect(cloudInit).not.toMatch(/iptables -I FORWARD 1 -i br\+ -j OPENADLC_EGRESS/);
  });

  it('runs hostd from a path the Docker daemon can see', () => {
    // Every bind mount hostd asks for is read by the daemon as a host path.
    expect(cloudInit).toContain('-v /var/lib/openadlc:/var/lib/openadlc');
    expect(cloudInit).toContain('OPENADLC_WORK_ROOT=$root/work');
    expect(cloudInit).toContain('OPENADLC_BOT_EGRESS_PROXY=http://host.docker.internal:3128');
    // And as the bots' own uid: on Linux, what hostd made as root the bot
    // could not write.
    expect(cloudInit).toContain('--user 1000:1000');
    expect(cloudInit).toContain('chown -R 1000:1000');
  });

  it('refuses a destination that is not on the list, rather than allowing it', () => {
    // `http_access deny all` has to come after the allow, and there has to be
    // an allow — a proxy that permits by default is not an allowlist.
    const allowAt = cloudInit.indexOf('http_access allow allowed_domains');
    const denyAt = cloudInit.indexOf('http_access deny all');
    expect(allowAt).toBeGreaterThan(-1);
    expect(denyAt).toBeGreaterThan(allowAt);
  });

  it('matches only the name a request gives, and refuses a bare IP address before the allow', () => {
    // Without `-n`, squid matched a request to an IP address by its reverse-DNS
    // name, which whoever holds the address sets: `x.github.com` passed.
    expect(cloudInit).toMatch(/^\s*acl allowed_domains dstdomain -n \$\{allowed_domains\}$/m);
    const literal = /^\s*acl to_ip_literal dstdom_regex -n (.+)$/m.exec(cloudInit)?.[1]?.split(/\s+/) ?? [];
    const refused = (host: string) => literal.some((pattern) => new RegExp(pattern).test(host));
    expect(refused('203.0.113.7')).toBe(true);
    expect(refused('[2001:db8::1]')).toBe(true);
    expect(refused('api.github.com')).toBe(false);
    const denyAt = cloudInit.indexOf('http_access deny to_ip_literal');
    expect(denyAt).toBeGreaterThan(-1);
    expect(denyAt).toBeLessThan(cloudInit.indexOf('http_access allow allowed_domains'));
  });

  it('takes the allowlist from the module rather than repeating it', () => {
    // Two copies of a security list is one copy that goes stale.
    expect(cloudInit).toContain('${allowed_domains}');
    expect(mainTf).toContain('allowed_domains = local.squid_domains');
    expect(mainTf).toContain('local.allowed_egress_domains');
  });

  it('stops a container going round the proxy to an address it resolved itself', () => {
    // The proxy is an allowlist; this is what makes it the only way out. A bot
    // that unsets HTTP_PROXY would otherwise just leave.
    expect(cloudInit).toContain('OPENADLC_EGRESS');
    expect(cloudInit).toContain('REJECT');
    expect(cloudInit).toContain('openadlc-egress-denied');
  });

  it('sends hostd through the proxy too', () => {
    // An allowlist that exempts the component holding the credentials is not an
    // allowlist.
    expect(cloudInit).toContain('HTTPS_PROXY=http://127.0.0.1:3128');
  });

  it('pins the proxy’s image by digest, not to a tag that moves', () => {
    // The proxy runs on the host's network, with the metadata server's token
    // in reach: `edge` was whatever Docker Hub said when a host was made.
    const image = /variable "egress_proxy_image" \{[^}]*default\s*=\s*"([^"]+)"/.exec(variablesTf)?.[1] ?? '';
    expect(image).toMatch(/^ubuntu\/squid:[^@]+@sha256:[0-9a-f]{64}$/);
    expect(image).not.toContain('edge');
  });

  it('turns the proxy variables on for Node’s own fetch in hostd', () => {
    // Without it Node's fetch ignores HTTPS_PROXY, and hostd's calls to Secret
    // Manager and the bridge went straight out.
    const env = /cat > "\$root\/hostd\.env" <<ENV\n([\s\S]*?)\n\s*ENV\n/.exec(cloudInit)?.[1] ?? '';
    expect(env).toMatch(/^\s*HTTPS_PROXY=http:\/\/127\.0\.0\.1:3128$/m);
    expect(env).toMatch(/^\s*NODE_USE_ENV_PROXY=1$/m);
  });

  it('refuses hostd a connection that goes round the proxy, after the destinations it may reach', () => {
    // The variables bind only a client that reads them; hostd runs on the
    // host's network as uid 1000, which FORWARD never sees.
    const firewall = withoutComments(cloudInit);
    expect(firewall).toContain('iptables -C OUTPUT -m owner --uid-owner 1000 -j OPENADLC_HOSTD 2>/dev/null || iptables -I OUTPUT 1 -m owner --uid-owner 1000 -j OPENADLC_HOSTD');
    const rules = [...firewall.matchAll(/iptables -A OPENADLC_HOSTD (.*?) *;? *\\?$/gm)].map((match) => match[1]);
    expect(rules).toEqual([
      '-m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
      '-d 127.0.0.0/8 -j ACCEPT',
      '-d 169.254.169.254/32 -j ACCEPT',
      '-d 172.16.0.0/12 -j ACCEPT',
      '-d 192.168.0.0/16 -j ACCEPT',
      '-d 10.0.0.0/8 -j ACCEPT',
      '-j LOG --log-prefix "openadlc-egress-denied " --log-level 4',
      '-j REJECT --reject-with icmp-port-unreachable',
    ]);
    // Flushed before it is filled, so a restart of the unit does not add the
    // rules twice behind their own REJECT.
    expect(firewall.indexOf('iptables -F OPENADLC_HOSTD')).toBeLessThan(firewall.indexOf('iptables -A OPENADLC_HOSTD'));
  });

  it('lets the host’s Docker daemon pull a task’s own Postgres image, as it pulls the task database server’s', () => {
    // hostd asks the daemon over the socket to pull pgvector/pgvector or
    // postgres from Docker Hub (apps/hostd/src/drivers/task-postgres.ts). The
    // daemon is root: only hostd's uid is held on OUTPUT, the VPC lets 443
    // out, and Docker Hub's names are on the allowlist besides. A rule on
    // OUTPUT for every uid, or Docker Hub taken off the list, would leave a
    // repository's tasks without their server.
    const firewall = withoutComments(cloudInit);
    const output = [...firewall.matchAll(/iptables -[AI] OUTPUT\b[^;\\'\n]*/g)].map((match) => match[0].trim());
    expect(output).toEqual(['iptables -I OUTPUT 1 -m owner --uid-owner 1000 -j OPENADLC_HOSTD']);
    expect(resourceBlock('google_compute_firewall', 'egress_web')).toContain('"443"');
    for (const name of ['auth.docker.io', 'registry-1.docker.io', 'production.cloudflare.docker.com']) expect(mainTf).toContain(`"${name}"`);
  });

  it('closes the ports the proxy does not use', () => {
    // There were no EGRESS rules in the module at all. A firewall cannot hold
    // domain names, but it can stop a process that ignores the proxy opening
    // its own socket on some other port.
    expect(declared.has('google_compute_firewall.deny_other_egress')).toBe(true);
    const web = resourceBlock('google_compute_firewall', 'egress_web');
    expect(web).toContain('direction = "EGRESS"');
    expect(web).toContain('"443"');
    expect(web).not.toContain('protocol = "all"');
  });

  it('hands the host its allowlist in cloud-init, not in a metadata key nothing reads', () => {
    // `fleet-allowed-domains` sat in the instance metadata under a comment
    // calling it enforcement, and nothing on the host ever read it.
    const host = resourceBlock('google_compute_instance', 'host');
    expect(host).toContain('user-data');
    expect(host).not.toMatch(/allowed-domains|hostd-port/);
  });

  it('makes a denial into a metric and an alert', () => {
    // Otherwise the refusal is a line in a log nobody reads.
    expect(declared.has('google_logging_metric.egress_denied')).toBe(true);
    const alert = resourceBlock('google_monitoring_alert_policy', 'egress_denied');
    expect(alert).toContain('var.egress_denial_rate_threshold');
    expect(alert).toContain('COMPARISON_GT');
    // Refusals a minute, as the threshold says, across both logs. ALIGN_RATE
    // is per second, and with five minutes held the alert needed 300 refusals
    // a minute for five minutes in a row.
    expect(alert).toContain('ALIGN_DELTA');
    expect(alert).toContain('REDUCE_SUM');
    expect(alert).not.toContain('ALIGN_RATE');
    expect(alert).toMatch(/alignment_period\s*=\s*"60s"/);
    const duration = /duration\s*=\s*"(\d+)s"/.exec(alert ?? '');
    expect(Number(duration?.[1])).toBeLessThanOrEqual(60);
  });

  it('names every allowed domain in docs/security.md', () => {
    // The security model's table went stale as entries were added to main.tf:
    // it named api.x.ai alone and left out the subscription sign-ins, the
    // image-build hosts and Docker Hub, so an operator read a smaller blast
    // radius than the proxy enforces. It also never said that DNS leaves
    // outside the list.
    const security = readFileSync(join(MODULE, '..', '..', 'docs', 'security.md'), 'utf8');
    const start = security.indexOf('\n## Egress');
    expect(start).toBeGreaterThan(-1);
    const end = security.indexOf('\n## ', start + 1);
    const section = security.slice(start, end === -1 ? undefined : end);
    const domains = egressDomains;
    expect(domains).toContain('auth.docker.io');
    for (const domain of domains) {
      expect(section.includes(`\`${domain}\``), `${domain} is not in docs/security.md's egress section`).toBe(true);
    }
    expect(section).toContain('extra_allowed_domains');
    expect(section).toContain('169.254.169.254');
    expect(section).not.toContain('None of it has been exercised');
  });

  it('lets the host reach a private registry named in registry_host, and tells hostd about it', () => {
    // The only way to name one was to replace the whole cloud-init, which also
    // turned the allowlist off; and the docs sent operators to
    // extra_allowed_domains, which opens the proxy and tells hostd nothing.
    const listStart = mainTf.indexOf('allowed_egress_domains = concat(');
    const list = withoutComments(mainTf.slice(listStart, mainTf.indexOf('squid_domains', listStart)));
    expect(list).toContain('var.registry_host != "" ? [var.registry_host] : []');
    expect(mainTf).toMatch(/registry_host\s*=\s*var\.registry_host/);
    const env = cloudInit.slice(cloudInit.indexOf('cat > "$root/hostd.env" <<ENV'), cloudInit.indexOf('\n      ENV\n'));
    expect(env).toContain('OPENADLC_REGISTRY_HOST=${registry_host}');
    const variable = /variable "registry_host" \{[\s\S]*?\n\}/.exec(variablesTf)?.[0] ?? '';
    expect(variable).toContain('default     = ""');
    expect(variable).toContain('openadlc-registry-token');
    expect(variable).toContain('validation {');
  });

  it('lets a Codex seat on a ChatGPT plan reach its model, not only sign in', () => {
    // Codex 0.155.1 signed in with a ChatGPT plan sends its model calls to
    // chatgpt.com/backend-api/codex and never to api.openai.com. With only
    // auth.openai.com open, the proxy refused the first model call of every
    // such seat, the lead and security reviewers by default.
    const listStart = mainTf.indexOf('allowed_egress_domains = concat(');
    const list = withoutComments(mainTf.slice(listStart, mainTf.indexOf('var.extra_allowed_domains', listStart)));
    expect(list).toContain('"auth.openai.com"');
    expect(list).toContain('"chatgpt.com"');
  });
});

describe('a first apply on a new project', () => {
  it.each([
    ['google_secret_manager_secret', 'database_url'],
    ['google_secret_manager_secret', 'webhook'],
    ['google_compute_global_address', 'console'],
    ['google_compute_health_check', 'hostd'],
    ['google_compute_managed_ssl_certificate', 'console'],
    ['google_logging_metric', 'egress_denied'],
    ['google_monitoring_alert_policy', 'egress_denied'],
    ['google_monitoring_alert_policy', 'host_heartbeat'],
    ['google_service_account', 'host'],
    ['google_service_account', 'bridge'],
    ['google_service_account', 'console'],
    ['google_project_iam_custom_role', 'secrets'],
    ['google_project_iam_custom_role', 'self_update'],
    ['google_artifact_registry_repository', 'ghcr'],
  ])('makes %s.%s only once its API is on', (type, name) => {
    // Nothing else orders them after the APIs: made in the same wave as the
    // enabling, they stopped the first apply with SERVICE_DISABLED.
    expect(resourceBlock(type, name)).toMatch(/depends_on\s*=\s*\[[^\]]*google_project_service\.enabled/);
  });

  it('makes the egress alert a minute after its metric, which Monitoring does not see at once', () => {
    // The alert policy, made in the same apply as its logging metric, read the
    // metric back as a 404, and the first apply of a fresh project ended in an
    // error that left no outputs. `validate` is as clean with the sleep gone,
    // or with nothing waiting on it, and the alert's `depends_on` still names
    // the APIs either way.
    const sleep = resourceBlock('time_sleep', 'egress_metric_visible');
    expect(sleep).toMatch(/create_duration\s*=\s*"60s"/);
    expect(sleep).toMatch(/triggers\s*=\s*\{[^}]*google_logging_metric\.egress_denied\./);
    // The trigger is the metric's id, which is its name: a metric replaced
    // under the same name slept nothing without this.
    expect(sleep).toMatch(/lifecycle\s*\{[^}]*replace_triggered_by\s*=\s*\[\s*google_logging_metric\.egress_denied\s*\]/);
    expect(resourceBlock('google_monitoring_alert_policy', 'egress_denied')).toMatch(
      /depends_on\s*=\s*\[[^\]]*time_sleep\.egress_metric_visible/,
    );
  });
});

describe('one install per project', () => {
  it('does not invite two installs into one project', () => {
    // The secrets are `openadlc-<ref>` whatever the prefix, and both accounts
    // read and write every secret in the project: a second install would
    // overwrite the first one's credentials and could read them.
    const description = /variable "name_prefix" \{[^}]*?description\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(variablesTf)?.[1] ?? '';
    expect(description).toContain('One install per project');
    expect(description).toContain('openadlc-<ref>');
    expect(description).toMatch(/every secret in the project/);
    expect(description).not.toMatch(/more than one install|several installs|installs? (can|may) share/i);
  });
});

describe('what the service accounts may do', () => {
  const role = resourceBlock('google_project_iam_custom_role', 'secrets') ?? '';
  const permissions = [...(/permissions\s*=\s*\[([^\]]*)\]/.exec(role)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? '');

  it('gives the host and the bridge only the secret permissions the secret store uses', () => {
    // Admin let a compromised host or bridge bind an outside account to the
    // app's key or a refresh token, which outlived revoking and rotating them.
    expect(withoutComments(mainTf)).not.toContain('roles/secretmanager.admin');
    for (const name of ['host_secrets', 'bridge_secrets']) {
      expect(resourceBlock('google_project_iam_member', name), name).toMatch(/role\s*=\s*google_project_iam_custom_role\.secrets\.name/);
    }
    expect(permissions.sort()).toEqual([
      'secretmanager.secrets.create',
      'secretmanager.secrets.delete',
      'secretmanager.secrets.get',
      'secretmanager.secrets.list',
      'secretmanager.versions.access',
      'secretmanager.versions.add',
      'secretmanager.versions.destroy',
      'secretmanager.versions.get',
      'secretmanager.versions.list',
    ]);
  });

  it('does not let a secret’s reader change who else may read it', () => {
    expect(permissions.filter((permission) => /setIamPolicy|getIamPolicy|\.update$/.test(permission))).toEqual([]);
    // Nor holds them to a name: the module's own secrets are `<name_prefix>-…`,
    // the store's `openadlc-…` and, until an install is renamed, `fleet-…`,
    // and create and list are checked on the project.
    expect(resourceBlock('google_project_iam_member', 'host_secrets')).not.toContain('condition');
    expect(resourceBlock('google_project_iam_member', 'bridge_secrets')).not.toContain('condition');
  });

  it('runs the console as an account of its own, not the bridge’s', () => {
    // The bridge's account reads every secret and the database; the console,
    // which calls no Google API, handed its token to any request forgery in it.
    const console = resourceBlock('google_cloud_run_v2_service', 'console');
    expect(console).toMatch(/service_account\s*=\s*google_service_account\.console\.email/);
    expect(console).not.toContain('google_service_account.bridge');
    expect(resourceBlock('google_service_account', 'console')).toContain('display_name = "OpenADLC console"');
  });

  it('grants the console’s account no role', () => {
    const grants = [...withoutComments(mainTf + deployerTf).matchAll(/^resource "google_[a-z_]*iam_[a-z_]*" "[^"]+" \{[\s\S]*?^\}/gm)].map((match) => match[0]);
    expect(grants.length).toBeGreaterThan(0);
    // The deployer may act as it, to roll out a console image; that is a grant
    // on the account, not to it.
    expect(grants.filter((grant) => /member\s*=[^\n]*google_service_account\.console\./.test(grant))).toEqual([]);
    expect(resourceBlock('google_service_account_iam_member', 'deployer_acts_as', deployerTf)).toMatch(/console\s*=\s*google_service_account\.console\.name/);
  });
});

describe('what is encrypted on the way', () => {
  // Where the bridge and the host both find the database's CA. One path for
  // both, because they read the same URL.
  const caDir = /database_ca_dir\s*=\s*"([^"]+)"/.exec(mainTf)?.[1];
  const caFile = /database_ca_file\s*=\s*"([^"]+)"/.exec(mainTf)?.[1];

  it('has the database refuse a connection that is not encrypted', () => {
    // The instance took plaintext as readily as TLS, so a client whose URL
    // lost its TLS settings carried the password and every row in the clear.
    const instance = resourceBlock('google_sql_database_instance', 'openadlc');
    expect(instance).toMatch(/ip_configuration \{[^}]*ssl_mode\s*=\s*"ENCRYPTED_ONLY"/);
    expect(instance).not.toContain('require_ssl');
  });

  it('checks the database against its own CA, in the form node-postgres does not read as verify-full', () => {
    // `no-verify` encrypted and let anything on the path answer for the
    // database. A bare `sslmode=require` is verify-full in node-postgres, and
    // Cloud SQL's certificate does not name the private IP: both would go down.
    expect(caDir).toBe('/var/lib/openadlc/database-ca');
    expect(caFile).toBe('server-ca.pem');
    const url = resourceBlock('google_secret_manager_secret_version', 'database_url');
    expect(url).toMatch(
      /secret_data\s*=\s*"postgres:\/\/[^"?]*\?sslmode=verify-ca&uselibpqcompat=true&sslrootcert=\$\{local\.database_ca_dir\}\/\$\{local\.database_ca_file\}"/,
    );
    expect(url).not.toMatch(/sslmode=(require|no-verify)/);
    expect(resourceBlock('google_secret_manager_secret', 'database_ca')).toContain('secret_id = "${var.name_prefix}-database-ca"');
    expect(resourceBlock('google_secret_manager_secret_version', 'database_ca')).toMatch(
      /secret_data\s*=\s*google_sql_database_instance\.openadlc\.server_ca_cert\[0\]\.cert/,
    );
  });

  it('rolls the bridge onto a new database URL, rather than leaving it on the one it started with', () => {
    // Cloud Run reads `latest` only when an instance starts, and a new secret
    // version does not roll the service.
    const bridge = resourceBlock('google_cloud_run_v2_service', 'bridge') ?? '';
    const env = bridge.slice(bridge.indexOf('name = "DATABASE_URL"'));
    expect(env.slice(0, env.indexOf('}'))).not.toContain('"latest"');
    expect(env).toMatch(/^[^}]*version\s*=\s*google_secret_manager_secret_version\.database_url\.version/);
  });

  it('mounts the CA in the bridge where the URL looks for it', () => {
    const bridge = resourceBlock('google_cloud_run_v2_service', 'bridge') ?? '';
    expect(bridge).toMatch(/volume_mounts \{\s*name\s*=\s*"database-ca"\s*mount_path\s*=\s*local\.database_ca_dir\s*\}/);
    expect(bridge).toMatch(/volumes \{\s*name\s*=\s*"database-ca"\s*secret \{\s*secret\s*=\s*google_secret_manager_secret\.database_ca\.secret_id/);
    expect(bridge).toMatch(/items \{\s*version\s*=\s*google_secret_manager_secret_version\.database_ca\.version\s*path\s*=\s*local\.database_ca_file\s*\}/);
  });

  it('writes the CA on the host where the URL looks for it, readable by hostd and the migrations', () => {
    expect(mainTf).toMatch(/database_ca_secret\s*=\s*google_secret_manager_secret\.database_ca\.secret_id/);
    const script = cloudInit.slice(cloudInit.indexOf('path: /etc/openadlc/prepare-hostd.sh'));
    expect(script).toContain('root=/var/lib/openadlc');
    expect(`/var/lib/openadlc/database-ca/${caFile}`).toBe(`${caDir}/${caFile}`);
    expect(script).toContain('ca_dir="$root/database-ca"');
    expect(script).toContain('secrets/${database_ca_secret}/versions/latest:access');
    expect(script).toContain('mv "$ca_dir/server-ca.pem.next" "$ca_dir/server-ca.pem"');
    expect(script).toContain('chmod 0644 "$ca_dir/server-ca.pem.next"');
    // Before the umask, or the file is root's alone and hostd (uid 1000) cannot read it.
    expect(script.indexOf('"$ca_dir/server-ca.pem"')).toBeLessThan(script.indexOf('umask 077'));
  });

  it('says when the host has to be reset to run on new settings', () => {
    // cloud-init is applied at boot: a host only restarted ran the old prepare
    // script against the new URL.
    const rollout = /output "host_rollout" \{[\s\S]*?\n\}/.exec(outputsTf)?.[0] ?? '';
    expect(rollout).toContain('local.host_cloud_init');
    expect(rollout).toContain('google_secret_manager_secret_version.database_url.version');
    expect(rollout).toContain('sha256(');
  });

  it('holds the load balancer to TLS 1.2 and up', () => {
    const policy = resourceBlock('google_compute_ssl_policy', 'console');
    expect(policy).toContain('min_tls_version = "TLS_1_2"');
    expect(resourceBlock('google_compute_target_https_proxy', 'console')).toContain('ssl_policy       = google_compute_ssl_policy.console.id');
  });
});

describe('the automation bot', () => {
  it('is the one whose role is automation unless one is named, not a retired persona', () => {
    expect(variablesTf).toMatch(/variable "automation_bot" \{[^}]*default\s*=\s*""/);
    expect(variablesTf).not.toMatch(/default\s*=\s*"flow"/);
    // Empty is no variable at all, rather than a name the bridge has to ignore.
    expect(resourceBlock('google_cloud_run_v2_service', 'bridge')).toMatch(/dynamic "env" \{\s*for_each = var\.automation_bot != ""/);
  });
});

describe('the alert for a host that stopped', () => {
  it('fires on uptime that is absent, which is all a stopped VM reports', () => {
    // A threshold on uptime below 1 never fired: a stopped VM writes no uptime,
    // and a threshold condition ignores absent data.
    const alert = resourceBlock('google_monitoring_alert_policy', 'host_heartbeat');
    expect(alert).toContain('compute.googleapis.com/instance/uptime');
    expect(alert).toMatch(/condition_absent\s*\{|evaluation_missing_data\s*=\s*"EVALUATION_MISSING_DATA_ACTIVE"/);
    expect(alert).not.toMatch(/hostd heartbeat/);
  });
});

describe('the weekly engine update on the host', () => {
  const botDockerfile = readFileSync(join(MODULE, '..', 'local', 'Dockerfile.bot'), 'utf8');
  const allowed = egressDomains;

  it('lets the bot image build through the proxy, which is the only way out for its steps', () => {
    // A build step is a container on Docker's default network, and the
    // firewall refuses it everything but the proxy. Each host the Dockerfile
    // fetches from, and Debian's own mirror for its apt-get, has to be listed.
    const fetched = [...botDockerfile.matchAll(/https?:\/\/([a-z0-9.-]+)/g)].map((match) => match[1]!);
    expect(fetched.length).toBeGreaterThan(0);
    // The enabled APIs are not egress: read as the list, they made a host the
    // proxy refuses look allowed.
    expect(allowed).not.toContain('artifactregistry.googleapis.com');
    for (const host of [...new Set(fetched), 'deb.debian.org', 'registry.npmjs.org']) {
      expect(allowed, `${host} is not on the egress allowlist`).toContain(host);
    }
  });

  it('installs gh from its signed apt repository, not a release download the proxy refuses', () => {
    // github.com/cli/cli/releases/download/... redirects to
    // release-assets.githubusercontent.com, which is not on the list, so every
    // cloud update died at that curl while github.com itself was allowed and
    // the check above passed. cli.github.com is on the list and signs its index.
    expect(botDockerfile).not.toMatch(/releases\/download/);
    expect(botDockerfile).toContain('https://cli.github.com/packages stable main');
    expect(botDockerfile).toMatch(/apt-get install -y --no-install-recommends "gh\$\{GH_VERSION:\+=\$\{GH_VERSION\}\}"/);
    expect(allowed).toContain('cli.github.com');
    expect(allowed).not.toContain('release-assets.githubusercontent.com');
  });

  it('checks a named Node tarball against the release’s SHASUMS256.txt before unpacking it', () => {
    const node = botDockerfile.slice(botDockerfile.indexOf('ARG NODE_VERSION='), botDockerfile.indexOf('ARG GH_VERSION='));
    expect(node).toContain('/SHASUMS256.txt');
    const checked = node.indexOf('sha256sum -c -');
    expect(checked).toBeGreaterThan(0);
    expect(checked).toBeLessThan(node.indexOf('tar -xJf'));
  });

  it('installs a fresh Node from nodesource’s signed repository under a key it checks, not a script piped to bash', () => {
    const node = botDockerfile.slice(botDockerfile.indexOf('ARG NODE_VERSION='), botDockerfile.indexOf('ARG GH_VERSION='));
    expect(node).not.toMatch(/\|\s*bash/);
    expect(node).toContain('6F71F525282841EEDAF851B42F59B5F99B1BE0B4');
    expect(node).toContain('signed-by=/usr/share/keyrings/nodesource.gpg');
    // The fingerprint is checked before the key is handed to apt.
    expect(node.indexOf('"$nodesource_key"')).toBeLessThan(node.indexOf('gpg --dearmor'));
  });

  it('lets the build fetch its base image from Docker Hub', () => {
    // `FROM debian:12-slim` is resolved through the same proxy: without these
    // the first cloud update failed "failed to fetch anonymous token … Forbidden".
    expect(botDockerfile).toMatch(/^FROM debian:/m);
    for (const host of ['auth.docker.io', 'registry-1.docker.io', 'production.cloudflare.docker.com']) {
      expect(allowed, `${host} is not on the egress allowlist`).toContain(host);
    }
  });

  it('does not pull the bot image back over the one the update built', () => {
    // Pulled on every start, the registry's `latest` would replace the one the
    // update swapped in, and the old engines would be back at the next restart.
    expect(cloudInit).not.toMatch(/^\s*ExecStartPre=\/usr\/bin\/docker pull \$\{bot_image\}\s*$/m);
    expect(cloudInit).toContain('docker image inspect ${bot_image} >/dev/null 2>&1 || exec /usr/bin/docker pull ${bot_image}');
  });
});

describe('the terminal a person reaches through the load balancer', () => {
  it('tells hostd which console may open it', () => {
    // The gateway admits a loopback console and the one OPENADLC_CONSOLE_URL
    // names. It used to admit any Origin matching the Host it was reached on,
    // which is also what a name rebound to the host looks like. Without this a
    // cloud console's socket is refused.
    expect(cloudInit).toContain('OPENADLC_CONSOLE_URL=https://${console_domain}');
    expect(mainTf).toMatch(/console_domain\s+=\s+local\.console_domain/);
  });
});

describe('a new hostd image on the host', () => {
  const prepare = cloudInit.slice(
    cloudInit.indexOf('path: /etc/openadlc/prepare-hostd.sh'),
    cloudInit.indexOf('path: /etc/systemd/system/openadlc-hostd.service'),
  );
  const hostdUnit = cloudInit.slice(cloudInit.indexOf('path: /etc/systemd/system/openadlc-hostd.service'), cloudInit.indexOf('runcmd:'));

  it('refreshes the app tree in place, rather than swapping it under the computers that mount it', () => {
    // The bug: `rm -rf app && mv app.next app`. A task computer that outlived
    // hostd's restart kept the deleted directories: an empty /skills and
    // /roles, no openadlc-ci, and the real gh and git first on its PATH.
    expect(prepare).not.toContain('rm -rf "$root/app" && mv');
    expect(prepare).toMatch(/refill\(\) \{\s*mkdir -p "\$2"\s*find "\$2" -mindepth 1 -delete\s*cp -R "\$1\/\." "\$2\/"/);
    expect(prepare).toContain('for dir in crew/skills crew/roles apps/hostd/bin; do\n            refill "$root/app.next/$dir" "$root/app/$dir"');
    expect(prepare).toContain('cp "$root/app.next/apps/hostd/dist/skill-runner.bundle.mjs" "$root/app/apps/hostd/dist/skill-runner.bundle.mjs"');
    // And the rest is cleared around them, never through them.
    for (const kept of ['crew/skills', 'crew/roles', 'apps/hostd/bin', 'apps/hostd/dist/skill-runner.bundle.mjs']) {
      expect(prepare).toContain(`-path "$root/app/${kept}"`);
    }
  });

  it('mounts the computers’ assets from directories outside the app tree, refilled rather than swapped', () => {
    // The compose stack's arrangement: the four paths hostd hands the daemon
    // as mount sources sit outside the tree an image change rewrites.
    for (const [name, path] of [
      ['OPENADLC_SKILLS_ROOT', '$root/assets/skills'],
      ['OPENADLC_ROLES_ROOT', '$root/assets/roles'],
      ['OPENADLC_RUNNER_BUNDLE', '$root/assets/skill-runner.bundle.mjs'],
      ['OPENADLC_GH_SHIM_DIR', '$root/assets/gh-shim'],
    ]) {
      expect(prepare).toContain(`\n      ${name}=${path}\n`);
    }
    expect(prepare).not.toMatch(/OPENADLC_(SKILLS_ROOT|ROLES_ROOT|RUNNER_BUNDLE|GH_SHIM_DIR)=\$root\/app/);
    expect(prepare).toContain('refill "$root/app/crew/skills" "$root/assets/skills"');
    expect(prepare).toContain('refill "$root/app/crew/roles" "$root/assets/roles"');
    expect(prepare).toContain('refill "$root/app/apps/hostd/bin" "$root/assets/gh-shim"');
    expect(prepare).toContain('cp "$root/app/apps/hostd/dist/skill-runner.bundle.mjs" "$root/assets/skill-runner.bundle.mjs"');
    expect(prepare).not.toMatch(/(rm -rf|mv) "?\$root\/assets/);
    expect(prepare).toContain('chown -R 1000:1000 "$root/assets"');
    // Filled after the app tree is, so the source is the new image's.
    expect(prepare.indexOf('refill "$root/app/crew/skills"')).toBeGreaterThan(prepare.indexOf('echo "$image_id" > "$root/app.image"'));
  });

  it('starts hostd when the seed refuses a seat, and not when a migration fails', () => {
    // A seed refusal comes from the database and never clears: as a failure of
    // this required ExecStartPre it held the only host in a restart loop.
    const step = /sh -c '(.*migrate\.js.*)'$/m.exec(prepare)?.[1] ?? '';
    expect(step).toMatch(/^node packages\/db\/dist\/cli\/migrate\.js && \{ node packages\/db\/dist\/cli\/seed\.js \|\| echo "\[prepare-hostd\] [^"]*" >&2; \}$/);
    expect(step).toContain('the seed reported a problem; hostd starts anyway');
  });

  it('restarts no container by name', () => {
    // The old line restarted `bot-*`, which no longer exist; restarting a
    // `task-*` computer would end the session in it.
    expect(prepare).not.toContain("grep '^bot-'");
    expect(prepare).not.toMatch(/docker (restart|stop)\b/);
    expect(prepare).not.toMatch(/'\^(bot|task|warm)-'/);
  });

  it('gives hostd long enough to end its tasks when it stops', () => {
    // docker stop's default 10 seconds cut hostd's drain off with tasks open.
    const grace = Number(/ExecStop=\/usr\/bin\/docker stop -t (\d+) openadlc-hostd/.exec(hostdUnit)?.[1]);
    expect(grace).toBeGreaterThanOrEqual(120);
    expect(Number(/TimeoutStopSec=(\d+)/.exec(hostdUnit)?.[1])).toBeGreaterThan(grace);
  });
});

describe('the workflow allowed to deploy', () => {
  const provider = resourceBlock('google_iam_workload_identity_pool_provider', 'github', deployerTf) ?? '';
  const condition = /attribute_condition = join\(" && ", \[([\s\S]*?)\]\)/.exec(provider)?.[1] ?? '';

  it('admits one workflow file on one branch of one repository, known by its ids', () => {
    // Matched by name alone, any workflow on the default branch could deploy,
    // started by any trigger, and a renamed repository's name could be taken.
    for (const claim of ['repository_id', 'repository_owner_id', 'workflow_ref']) {
      expect(provider).toContain(`"attribute.${claim}"`);
      expect(condition).toContain(`assertion.${claim} ==`);
    }
    expect(condition).toContain("assertion.repository_id == '${var.deployer_repository_id}'");
    expect(condition).toContain("assertion.repository_owner_id == '${var.deployer_repository_owner_id}'");
    expect(condition).toContain(
      "assertion.workflow_ref == '${var.deployer_repository}/${var.deployer_workflow}@refs/heads/${var.deployer_branch}'",
    );
  });

  it('binds the service account to the repository’s id, not its name', () => {
    const binding = resourceBlock('google_service_account_iam_member', 'deployer_federation', deployerTf) ?? '';
    expect(binding).toContain('/attribute.repository_id/${var.deployer_repository_id}');
    expect(binding).not.toContain('attribute.repository/');
  });

  it('refuses to plan a named repository without its ids, and keeps them out of the expression unless they are numbers', () => {
    expect(provider).toMatch(/precondition \{\s*condition\s*=\s*var\.deployer_repository_id != "" && var\.deployer_repository_owner_id != ""/);
    for (const name of ['deployer_repository_id', 'deployer_repository_owner_id', 'deployer_workflow']) {
      expect(variablesTf).toMatch(new RegExp(`variable "${name}" \\{[\\s\\S]*?default\\s*=[\\s\\S]*?validation \\{`));
    }
  });

  it('says what the deployer can do, rather than calling it narrow', () => {
    expect(deployerTf).not.toContain('nothing wider');
    expect(deployerTf).not.toContain('read-only token');
    const rolesComment = deployerTf.slice(deployerTf.lastIndexOf('\n\n', deployerTf.indexOf('resource "google_project_iam_member" "deployer"')));
    expect(rolesComment).toContain('the full GitHub App private key');
    const appKey = /variable "deployer_reads_app_key" \{[^}]*?description\s*=\s*"([^"]*)"/.exec(variablesTf)?.[1] ?? '';
    expect(appKey).toContain('the full key');
  });
});

describe('the images a release publishes, through a mirror of ghcr.io', () => {
  const mirror = resourceBlock('google_artifact_registry_repository', 'ghcr') ?? '';

  it('mirrors ghcr.io in the install’s region, since Cloud Run cannot pull from ghcr.io itself', () => {
    expect(mirror).toMatch(/repository_id\s*=\s*"\$\{var\.name_prefix\}-ghcr"/);
    expect(mirror).toMatch(/location\s*=\s*var\.region/);
    expect(mirror).toMatch(/format\s*=\s*"DOCKER"/);
    expect(mirror).toMatch(/mode\s*=\s*"REMOTE_REPOSITORY"/);
    expect(mirror).toMatch(/docker_repository \{\s*custom_repository \{\s*uri\s*=\s*"https:\/\/ghcr\.io"\s*\}/);
    expect(mirror).toMatch(/depends_on\s*=\s*\[[^\]]*google_project_service\.enabled/);
  });

  it('names an image under the mirror as the shared contract names it on ghcr.io', () => {
    // ghcr.io/620legal/openadlc/service@d is pulled as <mirror>/620legal/openadlc/service@d.
    expect(mainTf).toContain(
      'release_mirror     = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.ghcr.repository_id}"',
    );
    expect(mainTf).toContain('release_image_path = "${local.release_mirror}/${lower(var.release_repository)}"');
    expect(releaseImageName('620legal/OpenADLC', 'service')).toBe('ghcr.io/620legal/openadlc/service');
    const hostd = /hostd_release_image\s*=\s*"\$\{local\.release_image_path\}\/([a-z]+)"/.exec(mainTf)?.[1];
    expect(hostd).toBe('service');
    expect(RELEASE_IMAGES).toContain(hostd);
    // No bot image: a release holds none, and the host keeps bot_image.
    expect(RELEASE_IMAGES).not.toContain('bot');
    expect(mainTf).not.toContain('bot_release_image');
  });

  it('lets Cloud Run’s service agent and the host read the mirror, and the bridge only to update', () => {
    const reader = (name: string) => resourceBlock('google_artifact_registry_repository_iam_member', name) ?? '';
    for (const name of ['ghcr_cloud_run', 'ghcr_host', 'ghcr_bridge']) {
      expect(reader(name), name).toMatch(/repository\s*=\s*google_artifact_registry_repository\.ghcr\.name/);
      expect(reader(name), name).toMatch(/role\s*=\s*"roles\/artifactregistry\.reader"/);
    }
    expect(mainTf).toMatch(/cloud_run_agent\s*=\s*"serviceAccount:service-\$\{data\.google_project\.this\.number\}@serverless-robot-prod\.iam\.gserviceaccount\.com"/);
    expect(reader('ghcr_cloud_run')).toMatch(/member\s*=\s*local\.cloud_run_agent/);
    expect(reader('ghcr_host')).toContain('google_service_account.host.email');
    expect(reader('ghcr_host')).not.toMatch(/^\s*count\s*=/m);
    expect(reader('ghcr_bridge')).toContain('google_service_account.bridge.email');
    expect(reader('ghcr_bridge')).toMatch(/count\s*=\s*var\.self_update \? 1 : 0/);
  });

  it('makes neither service before its image can be pulled through the mirror', () => {
    for (const name of ['bridge', 'console']) {
      expect(resourceBlock('google_cloud_run_v2_service', name), name).toMatch(
        /depends_on\s*=\s*\[[^\]]*google_artifact_registry_repository_iam_member\.ghcr_cloud_run/,
      );
    }
  });
});

describe('an apply after an update', () => {
  it('leaves the image each service runs to the update that rolled it, and makes a service with the variable’s', () => {
    // The bridge rolls both services onto a release; an apply that set the
    // image back would put the install on the release it was made with.
    for (const [name, variable] of [
      ['bridge', 'bridge_image'],
      ['console', 'console_image'],
    ] as const) {
      const block = resourceBlock('google_cloud_run_v2_service', name) ?? '';
      const ignored = /ignore_changes\s*=\s*\[(.*)\]\s*$/m.exec(block)?.[1] ?? '';
      expect(ignored, name).toContain('template[0].containers[0].image');
      expect(ignored, name).toMatch(/\bscaling\b[\s\S]*\bclient\b[\s\S]*\bclient_version\b/);
      expect(block, name).toContain(`image = var.${variable}`);
    }
  });
});

describe('what the bridge is told about the install it updates', () => {
  const bridge = resourceBlock('google_cloud_run_v2_service', 'bridge') ?? '';

  it('names the cloud, the project and region, both services and the mirror', () => {
    expect(envValue(bridge, 'OPENADLC_CLOUD')).toBe('"gcp"');
    expect(envValue(bridge, 'OPENADLC_CLOUD_PROJECT')).toBe('var.project_id');
    expect(envValue(bridge, 'OPENADLC_CLOUD_REGION')).toBe('var.region');
    expect(envValue(bridge, 'OPENADLC_CLOUD_BRIDGE_SERVICE')).toBe('local.bridge_service');
    expect(envValue(bridge, 'OPENADLC_CLOUD_CONSOLE_SERVICE')).toBe('local.console_service');
    expect(envValue(bridge, 'OPENADLC_RELEASE_MIRROR')).toBe('local.release_mirror');
    expect(envValue(bridge, 'OPENADLC_RELEASE_REPO')).toBe('var.release_repository');
    expect(envValue(bridge, 'OPENADLC_SELF_UPDATE')).toBe('var.self_update ? "on" : "off"');
    // The names it is told are the names the services have.
    expect(bridge).toMatch(/^\s*name\s*=\s*local\.bridge_service$/m);
    expect(resourceBlock('google_cloud_run_v2_service', 'console')).toMatch(/^\s*name\s*=\s*local\.console_service$/m);
    expect(mainTf).toMatch(/bridge_service\s*=\s*"\$\{var\.name_prefix\}-bridge"/);
    expect(mainTf).toMatch(/console_service\s*=\s*"\$\{var\.name_prefix\}-console"/);
  });

  it('takes the project’s releases and updates itself unless told not to', () => {
    // Terraform reads no TypeScript, so the module keeps its own copy of the
    // repository the bridge, hostd and the CLI default to (PROJECT_REPOSITORY).
    // Apart, settings that never name one would have `openadlc cloud update`
    // choose one repository's releases while the module mirrors, and the host
    // accepts, another's images.
    const repo = /variable "release_repository" \{[\s\S]*?\n\}/.exec(variablesTf)?.[0] ?? '';
    expect(/default\s*=\s*"([^"]*)"/.exec(repo)?.[1]).toBe(PROJECT_REPOSITORY);
    expect(repo).toContain('validation {');
    const update = /variable "self_update" \{[\s\S]*?\n\}/.exec(variablesTf)?.[0] ?? '';
    expect(update).toMatch(/type\s*=\s*bool/);
    expect(update).toMatch(/default\s*=\s*true/);
    expect(update).toContain('openadlc cloud update');
  });
});

describe('what self-update hands the running bridge', () => {
  const bridgeGrants = [...withoutComments(mainTf + deployerTf).matchAll(/^resource "(google_[a-z0-9_]*iam_[a-z_]*)" "([^"]+)" \{[\s\S]*?^\}/gm)].filter(
    (match) => /member\s*=\s*"serviceAccount:\$\{google_service_account\.bridge\.email\}"/.test(match[0]),
  );

  it('rolls the two services, on those services alone, only with self_update, and cannot delete or make one', () => {
    const deploys = resourceBlock('google_cloud_run_v2_service_iam_member', 'bridge_deploys') ?? '';
    expect(deploys).toMatch(/for_each\s*=\s*var\.self_update \? \{/);
    expect(deploys).toMatch(/bridge\s*=\s*google_cloud_run_v2_service\.bridge\.name/);
    expect(deploys).toMatch(/console\s*=\s*google_cloud_run_v2_service\.console\.name/);
    expect(deploys).toMatch(/name\s*=\s*each\.value/);
    // run.developer could delete either service as well.
    expect(withoutComments(mainTf)).not.toContain('roles/run.developer');
    expect(deploys).toMatch(/role\s*=\s*google_project_iam_custom_role\.self_update\.name/);
    const role = resourceBlock('google_project_iam_custom_role', 'self_update') ?? '';
    const permissions = [...(/permissions\s*=\s*\[([^\]]*)\]/.exec(role)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    expect(permissions.sort()).toEqual(['run.operations.get', 'run.revisions.get', 'run.revisions.list', 'run.services.get', 'run.services.update']);
    // Made whatever self_update says: Google keeps a deleted role's id for a
    // week, and turning self_update off and on again would trip on it.
    expect(role).not.toMatch(/^\s*count\s*=/m);
  });

  it('reads the two services always, so the System row can tell the release in use with self-update off', () => {
    const reads = resourceBlock('google_cloud_run_v2_service_iam_member', 'bridge_reads') ?? '';
    expect(reads).toMatch(/for_each\s*=\s*\{/);
    expect(reads).not.toContain('self_update');
    expect(reads).toMatch(/bridge\s*=\s*google_cloud_run_v2_service\.bridge\.name/);
    expect(reads).toMatch(/console\s*=\s*google_cloud_run_v2_service\.console\.name/);
    expect(reads).toMatch(/role\s*=\s*"roles\/run\.viewer"/);
  });

  it('acts as the two services’ own accounts and no other, only with self_update', () => {
    const actsAs = resourceBlock('google_service_account_iam_member', 'bridge_acts_as') ?? '';
    expect(actsAs).toMatch(/for_each\s*=\s*var\.self_update \? \{/);
    expect(actsAs).toMatch(/bridge\s*=\s*google_service_account\.bridge\.name/);
    expect(actsAs).toMatch(/console\s*=\s*google_service_account\.console\.name/);
    expect(actsAs).not.toContain('google_service_account.host');
    expect(actsAs).toMatch(/role\s*=\s*"roles\/iam\.serviceAccountUser"/);
  });

  it('holds nothing project-wide for it', () => {
    const projectWide = bridgeGrants.filter((match) => match[1] === 'google_project_iam_member').map((match) => /role\s*=\s*(\S+)/.exec(match[0])?.[1]);
    expect(projectWide.sort()).toEqual(['"roles/cloudsql.client"', 'google_project_iam_custom_role.secrets.name']);
    // Everything else it holds is on one resource, and all of it but reading
    // its two services is self-update's.
    const rest = bridgeGrants.filter((match) => match[1] !== 'google_project_iam_member');
    expect(rest.map((match) => `${match[1]}.${match[2]}`).sort()).toEqual([
      'google_artifact_registry_repository_iam_member.ghcr_bridge',
      'google_cloud_run_v2_service_iam_member.bridge_deploys',
      'google_cloud_run_v2_service_iam_member.bridge_reads',
      'google_service_account_iam_member.bridge_acts_as',
    ]);
    for (const match of rest.filter((one) => one[2] !== 'bridge_reads')) expect(match[0], match[2]).toMatch(/var\.self_update \?/);
  });
});

describe('the host’s cloud-init as a template', () => {
  it('reads no name main.tf does not give it', () => {
    // `validate` passes with an unknown name in the template, and the apply
    // then fails on it, or a misspelt one renders as nothing on the host.
    const call = mainTf.slice(mainTf.indexOf('"${path.module}/cloud-init/host.yaml"'), mainTf.indexOf('\n  )', mainTf.indexOf('cloud-init/host.yaml')));
    const given = [...call.matchAll(/^\s{6}([a-z_]+)\s*=/gm)].map((match) => match[1]!);
    expect(given).toEqual(expect.arrayContaining(['hostd_release_image', 'release_mirror', 'release_repository']));
    expect(() => rendered(cloudInit, Object.fromEntries(given.map((name) => [name, `<${name}>`])))).not.toThrow();
  });
});

describe('the image hostd starts on', () => {
  const unit = cloudInit.slice(cloudInit.indexOf('path: /etc/systemd/system/openadlc-hostd.service'), cloudInit.indexOf('runcmd:'));
  const prepare = writtenFile('/etc/openadlc/prepare-hostd.sh');
  const named = `${HOSTD_RELEASE}@${digest('a')}`;

  it('is chosen before hostd is prepared, is the one that runs, and hostd is told where an update writes the next', () => {
    const steps = [...unit.matchAll(/^\s*ExecStartPre=(.*)$/gm)].map((match) => match[1] ?? '');
    const chooses = steps.indexOf('/bin/bash /etc/openadlc/hostd-image.sh');
    expect(chooses).toBeGreaterThan(-1);
    expect(chooses).toBeLessThan(steps.indexOf('/bin/bash /etc/openadlc/prepare-hostd.sh'));
    // After the registry login, which the pull needs.
    expect(steps.findIndex((step) => step.includes('docker-credential-gcr'))).toBeLessThan(chooses);
    expect(steps.join('\n')).not.toContain('docker pull ${hostd_image}');
    const start = unit.slice(unit.indexOf('ExecStart='), unit.indexOf('ExecStop='));
    expect(start).toContain('-e OPENADLC_HOSTD_IMAGE_FILE=/var/lib/openadlc/hostd-image');
    expect(start).not.toContain('BOT_IMAGE_FILE');
    // One read of the chosen image, both run and told to hostd, which reports it.
    expect(start).toContain("ExecStart=/bin/sh -c 'image=$$(cat /run/openadlc/running-hostd-image) && exec /usr/bin/docker run");
    expect(start).toContain('-e OPENADLC_HOSTD_IMAGE="$$image"');
    expect(start).toContain('"$$image" node apps/hostd/dist/main.js');
    expect(start).not.toContain('${hostd_image}');
    expect(unit).toMatch(/^\s*Restart=always$/m);
  });

  it('is what prepares the app tree and runs the migrations; the bots keep bot_image', () => {
    expect(prepare).toContain('hostd_in_use=$(cat /run/openadlc/running-hostd-image)');
    expect(prepare).not.toContain('${hostd_image}');
    expect(prepare).toContain(`docker image inspect -f '{{.Id}}' "$hostd_in_use"`);
    expect(prepare).toContain('docker create --name openadlc-app-source "$hostd_in_use"');
    expect(prepare).toMatch(/-w "\$root\/app" "\$hostd_in_use" \\\n\s*sh -c 'node packages\/db\/dist\/cli\/migrate\.js/);
    const env = /cat > "\$root\/hostd\.env" <<ENV\n([\s\S]*?)\nENV\n/.exec(prepare)?.[1] ?? '';
    expect(env).toMatch(/^OPENADLC_BOT_IMAGE=\$\{bot_image\}$/m);
    expect(env).toMatch(/^OPENADLC_RELEASE_MIRROR=\$\{release_mirror\}$/m);
    expect(mainTf).toMatch(/release_mirror\s+=\s+local\.release_mirror/);
    expect(cloudInit).not.toContain('bot-image');
  });

  it('is the module’s when no update has named one, its tag pulled at every start as before', () => {
    const started = hostStart(undefined, { present: ['registry/hostd:latest'] });
    expect(started.status, started.said).toBe(0);
    expect(started.hostd).toBe('registry/hostd:latest');
    expect(started.docker).toContain('pull registry/hostd:latest');
    expect(started.said).not.toContain('passed over');
    // A module image named by digest, as configure writes a release's, only when absent.
    const pinned = hostStart(undefined, { hostdImage: named, present: [named] });
    expect(pinned.status, pinned.said).toBe(0);
    expect(pinned.docker.filter((call) => call.startsWith('pull'))).toEqual([]);
  });

  it('is the release an update named, pulled only when the host does not have it', () => {
    const fresh = hostStart(`${named}\n`);
    expect(fresh.status, fresh.said).toBe(0);
    expect(fresh.hostd).toBe(named);
    expect(fresh.docker).toContain(`pull ${named}`);
    expect(fresh.docker.join('\n')).not.toContain('registry/');
    // A digest names the same bytes for ever, so one the host has is not asked for again.
    const again = hostStart(`${named}\n`, { present: [named] });
    expect(again.status, again.said).toBe(0);
    expect(again.docker.filter((call) => call.startsWith('pull'))).toEqual([]);
    // And a file without its newline is the same file.
    expect(hostStart(named).hostd).toBe(named);
  });

  it('is the module’s, quietly, for the empty file no update has written yet', () => {
    const started = hostStart('');
    expect(started.status, started.said).toBe(0);
    expect(started.hostd).toBe('registry/hostd:latest');
    expect(started.said).not.toContain('does not name');
  });

  it.each([
    ['a tag, not a digest', `${HOSTD_RELEASE}:v0.2.0\n`],
    ['a short digest', `${HOSTD_RELEASE}@sha256:${'a'.repeat(63)}\n`],
    ['a digest in capitals', `${HOSTD_RELEASE}@sha256:${'A'.repeat(64)}\n`],
    ['the console’s image', `${MIRROR}/620legal/openadlc/console@${digest('a')}\n`],
    ['the image on ghcr.io itself, not through the mirror', `ghcr.io/620legal/openadlc/service@${digest('a')}\n`],
    ['another package on ghcr.io, which the mirror would pull as readily', `${MIRROR}/someone/else/service@${digest('a')}\n`],
    ['two lines', `${named}\n${HOSTD_RELEASE}@${digest('c')}\n`],
    ['words for a shell', `${named}; reboot\n`],
    ['half of one', `${HOSTD_RELEASE}@sha256:aaaa`],
  ])('is the module’s, said, for a file that is %s', (_, written) => {
    const started = hostStart(written);
    expect(started.status, started.said).toBe(0);
    expect(started.hostd).toBe('registry/hostd:latest');
    expect(started.said).toContain('hostd-image does not name');
    // Nothing the file said is pulled.
    expect(started.docker.filter((call) => call.startsWith('pull'))).toEqual(['pull registry/hostd:latest']);
  });

  it('falls back to the image hostd last answered on before hostd_image, for a file emptied or cut short by a crash', () => {
    // hostd writes the file in place: a crash between the truncate and the
    // write leaves it empty or half written, and hostd_image is the release
    // the install was made with, under a database newer ones migrated.
    const last = `${HOSTD_RELEASE}@${digest('d')}`;
    for (const written of ['', `${HOSTD_RELEASE}@sha256:dd`]) {
      const started = hostStart(written, { started: `${last}\n`, present: [last] });
      expect(started.status, started.said).toBe(0);
      expect(started.hostd).toBe(last);
      expect(started.docker.join('\n')).not.toContain('registry/hostd:latest');
    }
    // Only a release image by digest counts there too.
    const odd = hostStart('', { started: 'registry/other:latest\n' });
    expect(odd.hostd).toBe('registry/hostd:latest');
    // And one that will not pull is passed over for hostd_image, said.
    const gone = hostStart('', { started: `${last}\n`, unpullable: [last] });
    expect(gone.status, gone.said).toBe(0);
    expect(gone.hostd).toBe('registry/hostd:latest');
    expect(gone.said).toContain(`could not pull ${last}`);
  });

  it('fails the start, for systemd to try again, when the release it names will not pull, rather than run an older one', () => {
    const started = hostStart(named, { present: ['registry/hostd:latest'], unpullable: [named] });
    expect(started.status).not.toBe(0);
    expect(started.said).toContain(`could not pull ${named}`);
    expect(started.hostd).toBeNull();
    expect(started.docker.join('\n')).not.toContain('registry/hostd:latest');
  });

  it('fails the start when the module’s own image will not pull, as before', () => {
    const started = hostStart(undefined, { unpullable: ['registry/hostd:latest'] });
    expect(started.status).not.toBe(0);
    expect(started.hostd).toBeNull();
  });

  it('makes the file, empty, and hostd’s (uid 1000), which writes it in place, and nothing else of the directory', () => {
    const fresh = hostStart(undefined);
    expect(fresh.file).toEqual({ text: '', mode: 0o644 });
    expect(fresh.chowned).toEqual([expect.stringMatching(/^1000:1000 \S+var-lib-openadlc\/hostd-image$/)]);
    // A file an update wrote is kept as it is, and made hostd's again.
    const written = hostStart(`${named}\n`);
    expect(written.file?.text).toBe(`${named}\n`);
    expect(written.chowned).toEqual([expect.stringMatching(/hostd-image$/)]);
  });
});

describe('the image hostd last answered on', () => {
  const unit = cloudInit.slice(cloudInit.indexOf('path: /etc/systemd/system/openadlc-hostd.service'), cloudInit.indexOf('runcmd:'));

  /** One run of `/etc/openadlc/hostd-started.sh`, with a curl whose /healthz answers or not. */
  function recorded(answers: boolean, before?: string): { status: number | null; started: string | null; said: string } {
    const work = mkdtempSync(join(tmpdir(), 'openadlc-host-started-'));
    scratch.push(work);
    const root = join(work, 'var-lib-openadlc');
    const run = join(work, 'run-openadlc');
    const bin = join(work, 'bin');
    for (const dir of [root, run, bin]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(run, 'running-hostd-image'), `${HOSTD_RELEASE}@${digest('a')}\n`);
    if (before !== undefined) writeFileSync(join(root, 'hostd-image.started'), before);
    for (const [name, body] of [
      ['curl', answers ? 'case "$*" in *http://127.0.0.1:47312/healthz*) exit 0 ;; esac; exit 7' : 'exit 7'],
      ['sleep', 'exit 0'],
    ]) {
      writeFileSync(join(bin, name!), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name!), 0o755);
    }
    const script = rendered(writtenFile('/etc/openadlc/hostd-started.sh'), { hostd_port: '47312' }).split('/var/lib/openadlc').join(root).split('/run/openadlc').join(run);
    writeFileSync(join(work, 'hostd-started.sh'), script);
    const done = spawnSync('bash', [join(work, 'hostd-started.sh')], { env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` }, encoding: 'utf8' });
    const file = join(root, 'hostd-image.started');
    return { status: done.status, started: existsSync(file) ? readFileSync(file, 'utf8') : null, said: `${done.stdout}${done.stderr}` };
  }

  it('is recorded once hostd answers on it, after it starts', () => {
    expect(unit).toMatch(/^\s*ExecStartPost=-\/bin\/bash \/etc\/openadlc\/hostd-started\.sh$/m);
    expect(recorded(true).started).toBe(`${HOSTD_RELEASE}@${digest('a')}\n`);
  });

  it('is left as it was when hostd never answers, and never fails the start', () => {
    const left = recorded(false, 'before\n');
    expect(left.status).toBe(0);
    expect(left.started).toBe('before\n');
    expect(left.said).toContain('did not answer');
  });

  it('is root’s: hostd, which writes the other file, is given nothing of it', () => {
    expect(writtenFile('/etc/openadlc/hostd-image.sh')).not.toMatch(/chown[^\n]*started/);
    expect(writtenFile('/etc/openadlc/hostd-started.sh')).not.toContain('chown');
  });

  it('gives the pulls, the migrations and the wait for hostd longer than systemd’s default to start', () => {
    const minutes = Number(/^\s*TimeoutStartSec=(\d+)min$/m.exec(unit)?.[1]);
    expect(minutes).toBeGreaterThanOrEqual(10);
  });
});

describe('what the docs say about a cloud install and its releases', () => {
  const selfHosting = readFileSync(join(MODULE, '..', '..', 'docs', 'self-hosting.md'), 'utf8');
  const section = (heading: string) => {
    const start = selfHosting.indexOf(`\n## ${heading}\n`);
    const end = selfHosting.indexOf('\n## ', start + 1);
    return selfHosting.slice(start, end < 0 ? undefined : end).replace(/\s+/g, ' ');
  };

  it('installs from release images through the mirror, builds only with --build, and says the next apply resets the host', () => {
    const installing = section('Installing on a cloud');
    expect(installing).toContain('<name_prefix>-ghcr');
    expect(installing).toContain('--build');
    expect(installing).toContain('gh attestation verify');
    expect(installing).toContain('resets the host');
    expect(installing).toContain('self_update');
  });

  it('upgrades a cloud install one release at a time with openadlc cloud update', () => {
    const upgrading = section('Upgrading');
    expect(upgrading).toContain('openadlc cloud update');
    expect(upgrading).toContain('--release');
    expect(upgrading).toContain('one release at a time');
    expect(upgrading).toContain('Settings → System');
  });
});

describe('the names from before the rename to OpenADLC', () => {
  const runbook = readFileSync(join(MODULE, '..', '..', 'docs', 'runbooks', 'rename-gcp-host.md'), 'utf8');
  const store = readFileSync(join(MODULE, '..', '..', 'packages', 'github', 'src', 'gcp-secrets.ts'), 'utf8');
  const constant = (name: string, file = store) => new RegExp(`const ${name} = '([^']+)'`).exec(file)?.[1] ?? '';
  const units = [...cloudInit.matchAll(/^ {2}- path: \/etc\/systemd\/system\/(\S+)\.service$/gm)].map((match) => match[1]!);
  const move = writtenFile('/etc/openadlc/from-fleet.sh');

  it('names the host’s units, its paths, its tag and its path matcher OpenADLC’s way, and the old ones only where it moves them', () => {
    expect(units.sort()).toEqual(['openadlc-egress-firewall', 'openadlc-egress-proxy', 'openadlc-hostd']);
    const comment = cloudInit.indexOf('  # A host made before the rename');
    const rest = (cloudInit.slice(0, comment) + cloudInit.slice(cloudInit.indexOf('  - path: /etc/openadlc/squid.conf'))).replace('  - /bin/bash /etc/openadlc/from-fleet.sh\n', '');
    expect(comment).toBeGreaterThan(0);
    expect(rest).not.toMatch(/fleet/i);
    expect(resourceBlock('google_compute_instance', 'host')).toMatch(/tags\s*=\s*\["openadlc-host"\]/);
    const urlMap = resourceBlock('google_compute_url_map', 'console') ?? '';
    expect(urlMap).toMatch(/path_matcher = "openadlc"/);
    expect(urlMap).toMatch(/path_matcher \{\s*name\s*=\s*"openadlc"/);
    // What is left is the moved blocks' old addresses and Cloud SQL's names,
    // which renaming would mean moving the data.
    const left = withoutComments([mainTf, variablesTf, deployerTf, outputsTf].join('\n'))
      .split('\n')
      .filter((line) => /fleet/i.test(line))
      .filter((line) => !/^\s*from = google_[a-z_]+\.fleet$/.test(line))
      .filter((line) => !/fleet_db/.test(line));
    expect(left.map((line) => line.trim())).toEqual(['name     = "fleet"']);
    expect(resourceBlock('google_sql_user', 'openadlc')).toContain('name     = "fleet"');
  });

  it('grants the deployer the app key by its new name, the new grant made before the old one goes', () => {
    const grant = resourceBlock('google_secret_manager_secret_iam_member', 'deployer_app_key', deployerTf) ?? '';
    expect(grant).toContain(`secret_id = "${constant('SECRET_ID_PREFIX')}github-app-private-key"`);
    expect(grant).toMatch(/lifecycle \{\s*create_before_destroy = true\s*\}/);
  });

  it('makes the database URL’s new version before the old one goes, so the bridge’s running revision never names a destroyed one', () => {
    const version = resourceBlock('google_secret_manager_secret_version', 'database_url') ?? '';
    expect(version).toContain('sslrootcert=${local.database_ca_dir}');
    expect(version).toMatch(/lifecycle \{\s*create_before_destroy = true\s*\}/);
  });

  /** One boot's move, run by bash with scratch directories in place of /var/lib/fleet and /var/lib/openadlc. */
  function boot(has: { old?: boolean; new?: boolean }): { status: number | null; said: string; old: boolean; moved: string | null } {
    const work = mkdtempSync(join(tmpdir(), 'openadlc-from-fleet-'));
    scratch.push(work);
    const old = join(work, 'var-lib-fleet');
    const now = join(work, 'var-lib-openadlc');
    if (has.old) {
      mkdirSync(join(old, 'logins'), { recursive: true });
      writeFileSync(join(old, 'hostd-image.started'), `${HOSTD_RELEASE}@${digest('a')}\n`);
    }
    if (has.new) mkdirSync(now);
    const script = rendered(move, {}).split('/var/lib/fleet').join(old).split('/var/lib/openadlc').join(now);
    writeFileSync(join(work, 'from-fleet.sh'), script);
    const ran = spawnSync('bash', [join(work, 'from-fleet.sh')], { encoding: 'utf8' });
    const started = join(now, 'hostd-image.started');
    return { status: ran.status, said: `${ran.stdout}${ran.stderr}`, old: existsSync(old), moved: existsSync(started) ? readFileSync(started, 'utf8').trim() : null };
  }

  it('moves a host’s state from /var/lib/fleet once, before any unit starts, so hostd keeps its image and the bots their sign-ins', () => {
    const moved = boot({ old: true });
    expect(moved).toMatchObject({ status: 0, old: false, moved: `${HOSTD_RELEASE}@${digest('a')}` });
    expect(moved.said).toContain('[openadlc] moved');
    // Every boot after the first, and a host made on these names.
    expect(boot({ new: true })).toMatchObject({ status: 0, said: '' });
    expect(boot({})).toMatchObject({ status: 0, said: '' });
    const runcmd = cloudInit.slice(cloudInit.indexOf('runcmd:'));
    expect(runcmd.indexOf('- /bin/bash /etc/openadlc/from-fleet.sh')).toBeGreaterThan(0);
    expect(runcmd.indexOf('- /bin/bash /etc/openadlc/from-fleet.sh')).toBeLessThan(runcmd.indexOf('systemctl enable --now'));
  });

  it('leaves both where they are, and says so, on a host that has both', () => {
    const both = boot({ old: true, new: true });
    expect(both).toMatchObject({ status: 1, old: true, moved: null });
    expect(both.said).toContain('are both here');
    expect(both.said).toContain('docs/runbooks/rename-gcp-host.md');
    expect(runbook).toContain('/var/lib/fleet and /var/lib/openadlc are both here');
  });

  it('has the runbook name what the module and the store name, old and new', () => {
    // Each unit, new and old, as the runbook's checks and its table name them.
    for (const unit of units) {
      expect(runbook, unit).toContain(unit);
      expect(runbook, unit).toContain(unit.replace(/^openadlc-/, 'fleet-'));
    }
    expect(runbook).toContain('systemctl is-active openadlc-egress-proxy openadlc-egress-firewall openadlc-hostd');
    expect(move).toContain('old=/var/lib/fleet');
    expect(move).toContain('new=/var/lib/openadlc');
    expect(runbook).toContain('`/etc/openadlc/from-fleet.sh`');
    expect(writtenFile('/etc/openadlc/prepare-hostd.sh')).toContain('root=/var/lib/openadlc');
    expect(runbook).toContain('cat /var/lib/openadlc/hostd-image.started');
    // The tag, as the firewall's rules name it, and every rule the runbook lists.
    expect(runbook).toContain("--filter='targetTags:openadlc-host'");
    const rules = [...mainTf.matchAll(/^resource "google_compute_firewall" "[^"]+" \{\n\s*name\s*=\s*"\$\{var\.name_prefix\}(-[a-z-]+)"/gm)].map((match) => match[1]!);
    expect(rules).toHaveLength(7);
    expect(runbook).toContain('the seven');
    for (const rule of rules) expect(runbook, rule).toContain(`\`${rule === '-allow-iap' ? '<prefix>-allow-iap' : rule}\``);
    // The CA where the URL now looks for it.
    const caDir = /database_ca_dir\s*=\s*"([^"]+)"/.exec(mainTf)?.[1];
    expect(runbook).toContain(`${caDir}/server-ca.pem`);
    // The store's names and labels, which every copy and its way back write.
    const [prefix, label, oldPrefix, oldLabel] = ['SECRET_ID_PREFIX', 'SECRET_LABEL', 'OLD_ID_PREFIX', 'OLD_LABEL'].map((name) => constant(name));
    expect([prefix, label, oldPrefix, oldLabel]).toEqual(['openadlc-', 'openadlc', 'fleet-', 'fleet']);
    expect(runbook).toContain(`new="${prefix}\${old#${oldPrefix}}"`);
    expect(runbook).toContain(`old="${oldPrefix}\${new#${prefix}}"`);
    const creates = runbook.split('\n').filter((line) => line.includes('gcloud secrets create'));
    expect(creates.length).toBeGreaterThan(1);
    for (const line of creates) expect(line).toMatch(new RegExp(`--labels=(${label}|${oldLabel})=secret`));
    expect(creates.filter((line) => line.includes(`--labels=${label}=secret`))).toHaveLength(1);
    // Never by an `openadlc-` name: the module's own secrets share it under the default prefix.
    expect(runbook).not.toMatch(/grep '\^openadlc-'|filter='name:openadlc/);
    // The card that sends a person here.
    const check = readFileSync(join(MODULE, '..', '..', 'apps', 'bridge', 'src', 'health', 'checks', 'cloud-names.ts'), 'utf8');
    expect(constant('OLD_NAMES_TITLE', check)).not.toBe('');
    expect(runbook).toContain(`"${constant('OLD_NAMES_TITLE', check)}"`);
  });
});
