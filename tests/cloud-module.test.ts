import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
      expect(block, rule).toMatch(/target_tags\s*=\s*\["fleet-host"\]/);
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
    expect(/name\s*=\s*"FLEETADLC_IDENTITY_MODE"\s*\n\s*value\s*=\s*(.+)/.exec(bridge)?.[1]?.trim()).toBe('"iap"');
    const console = resourceBlock('google_cloud_run_v2_service', 'console') ?? '';
    expect(/name\s*=\s*"FLEETADLC_IDENTITY_MODE_EXPECTED"\s*\n\s*value\s*=\s*(.+)/.exec(console)?.[1]?.trim()).toBe('"iap"');
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
    expect(bridge).toContain('FLEETADLC_IDENTITY_MODE');
    expect(bridge).toContain('FLEETADLC_IAP_AUDIENCE');
    expect(bridge).toContain('google_compute_backend_service.console.generated_id');
  });
});

describe('what the operator is told to do', () => {
  it('points them at the load balancer, not at the Cloud Run URL', () => {
    // The Cloud Run URL stopped answering when its ingress was restricted, so
    // an output naming it would send an operator somewhere that refuses them.
    expect(outputsTf).toContain('https://${var.console_domain}');
    expect(outputsTf).toContain('google_compute_global_address.console.address');
  });

  it('sends them to the console, not to a fleetadlc the host does not have', () => {
    // The host runs Container-Optimized OS: no Node, no fleetadlc. Run from a
    // laptop instead, auth login cannot write the install's secret store and
    // doctor probes 127.0.0.1.
    const steps = /output "next_steps" \{[\s\S]*?<<-EOT([\s\S]*?)EOT/.exec(outputsTf)?.[1] ?? '';
    expect(steps).not.toMatch(/fleetadlc (auth login|doctor|github check|restore)/);
    const words = steps.replace(/\s+/g, ' ');
    expect(words).toContain('GitHub accounts step');
    expect(words).toContain('health cards');
    expect(words).toContain('webhook card shows whether a delivery arrived');
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
    expect(bridge).toContain('FLEETADLC_WEBHOOK_SECRET');
  });

  it('wires the webhook secret, rather than leaving verification off', () => {
    // An unset FLEETADLC_WEBHOOK_SECRET makes the bridge refuse every delivery.
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
    expect(outputsTf).toContain('https://${var.console_domain}/webhooks/github');
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
    for (const unit of ['fleet-egress-proxy.service', 'fleet-egress-firewall.service', 'fleet-hostd.service']) {
      expect(cloudInit).toContain(`systemctl enable --now ${unit}`);
    }
    expect(cloudInit).toContain('Requires=fleet-egress-proxy.service');
    expect(cloudInit).toContain('Requires=fleet-egress-firewall.service');
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
    // fleetadlc-tasks bridge has to be let in from a docker bridge, and from
    // nowhere else.
    expect(cloudInit).toContain('iptables -I INPUT 1 -i br+ -p tcp --dport 47433 -j ACCEPT');
    expect(cloudInit).not.toMatch(/iptables -I INPUT 1 -p tcp --dport 47433/);
  });

  it('hooks the egress chain where Docker cannot put its own rules ahead of it', () => {
    // Inserted at the top of FORWARD, it ended up behind Docker's ACCEPTs once
    // the daemon built its chains, and a bot went straight out.
    expect(cloudInit).toContain('iptables -I DOCKER-USER 1 -i br+ -j FLEETADLC_EGRESS');
    expect(cloudInit).not.toMatch(/iptables -I FORWARD 1 -i br\+ -j FLEETADLC_EGRESS/);
  });

  it('runs hostd from a path the Docker daemon can see', () => {
    // Every bind mount hostd asks for is read by the daemon as a host path.
    expect(cloudInit).toContain('-v /var/lib/fleet:/var/lib/fleet');
    expect(cloudInit).toContain('FLEETADLC_WORK_ROOT=$root/work');
    expect(cloudInit).toContain('FLEETADLC_BOT_EGRESS_PROXY=http://host.docker.internal:3128');
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
    expect(cloudInit).toContain('FLEETADLC_EGRESS');
    expect(cloudInit).toContain('REJECT');
    expect(cloudInit).toContain('fleetadlc-egress-denied');
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
    expect(firewall).toContain('iptables -C OUTPUT -m owner --uid-owner 1000 -j FLEETADLC_HOSTD 2>/dev/null || iptables -I OUTPUT 1 -m owner --uid-owner 1000 -j FLEETADLC_HOSTD');
    const rules = [...firewall.matchAll(/iptables -A FLEETADLC_HOSTD (.*?) *;? *\\?$/gm)].map((match) => match[1]);
    expect(rules).toEqual([
      '-m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
      '-d 127.0.0.0/8 -j ACCEPT',
      '-d 169.254.169.254/32 -j ACCEPT',
      '-d 172.16.0.0/12 -j ACCEPT',
      '-d 192.168.0.0/16 -j ACCEPT',
      '-d 10.0.0.0/8 -j ACCEPT',
      '-j LOG --log-prefix "fleetadlc-egress-denied " --log-level 4',
      '-j REJECT --reject-with icmp-port-unreachable',
    ]);
    // Flushed before it is filled, so a restart of the unit does not add the
    // rules twice behind their own REJECT.
    expect(firewall.indexOf('iptables -F FLEETADLC_HOSTD')).toBeLessThan(firewall.indexOf('iptables -A FLEETADLC_HOSTD'));
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
    expect(env).toContain('FLEETADLC_REGISTRY_HOST=${registry_host}');
    const variable = /variable "registry_host" \{[\s\S]*?\n\}/.exec(variablesTf)?.[0] ?? '';
    expect(variable).toContain('default     = ""');
    expect(variable).toContain('fleet-registry-token');
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
  ])('makes %s.%s only once its API is on', (type, name) => {
    // Nothing else orders them after the APIs: made in the same wave as the
    // enabling, they stopped the first apply with SERVICE_DISABLED.
    expect(resourceBlock(type, name)).toMatch(/depends_on\s*=\s*\[[^\]]*google_project_service\.enabled/);
  });
});

describe('one install per project', () => {
  it('does not invite two installs into one project', () => {
    // The secrets are `fleet-<ref>` whatever the prefix, and both accounts
    // read and write every secret in the project: a second install would
    // overwrite the first one's credentials and could read them.
    const description = /variable "name_prefix" \{[^}]*?description\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(variablesTf)?.[1] ?? '';
    expect(description).toContain('One install per project');
    expect(description).toContain('fleet-<ref>');
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
    // Nor holds them to `fleet-`: the module's own secrets are `<name_prefix>-…`,
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
    const instance = resourceBlock('google_sql_database_instance', 'fleet');
    expect(instance).toMatch(/ip_configuration \{[^}]*ssl_mode\s*=\s*"ENCRYPTED_ONLY"/);
    expect(instance).not.toContain('require_ssl');
  });

  it('checks the database against its own CA, in the form node-postgres does not read as verify-full', () => {
    // `no-verify` encrypted and let anything on the path answer for the
    // database. A bare `sslmode=require` is verify-full in node-postgres, and
    // Cloud SQL's certificate does not name the private IP: both would go down.
    expect(caDir).toBe('/var/lib/fleet/database-ca');
    expect(caFile).toBe('server-ca.pem');
    const url = resourceBlock('google_secret_manager_secret_version', 'database_url');
    expect(url).toMatch(
      /secret_data\s*=\s*"postgres:\/\/[^"?]*\?sslmode=verify-ca&uselibpqcompat=true&sslrootcert=\$\{local\.database_ca_dir\}\/\$\{local\.database_ca_file\}"/,
    );
    expect(url).not.toMatch(/sslmode=(require|no-verify)/);
    expect(resourceBlock('google_secret_manager_secret', 'database_ca')).toContain('secret_id = "${var.name_prefix}-database-ca"');
    expect(resourceBlock('google_secret_manager_secret_version', 'database_ca')).toMatch(
      /secret_data\s*=\s*google_sql_database_instance\.fleet\.server_ca_cert\[0\]\.cert/,
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
    const script = cloudInit.slice(cloudInit.indexOf('path: /etc/fleet/prepare-hostd.sh'));
    expect(script).toContain('root=/var/lib/fleet');
    expect(`/var/lib/fleet/database-ca/${caFile}`).toBe(`${caDir}/${caFile}`);
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
    // The gateway admits a loopback console and the one FLEETADLC_CONSOLE_URL
    // names. It used to admit any Origin matching the Host it was reached on,
    // which is also what a name rebound to the host looks like. Without this a
    // cloud console's socket is refused.
    expect(cloudInit).toContain('FLEETADLC_CONSOLE_URL=https://${console_domain}');
    expect(mainTf).toMatch(/console_domain\s+=\s+var\.console_domain/);
  });
});

describe('a new hostd image on the host', () => {
  const prepare = cloudInit.slice(
    cloudInit.indexOf('path: /etc/fleet/prepare-hostd.sh'),
    cloudInit.indexOf('path: /etc/systemd/system/fleet-hostd.service'),
  );
  const hostdUnit = cloudInit.slice(cloudInit.indexOf('path: /etc/systemd/system/fleet-hostd.service'), cloudInit.indexOf('runcmd:'));

  it('refreshes the app tree in place, rather than swapping it under the computers that mount it', () => {
    // The bug: `rm -rf app && mv app.next app`. A task computer that outlived
    // hostd's restart kept the deleted directories: an empty /skills and
    // /roles, no fleetadlc-ci, and the real gh and git first on its PATH.
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
      ['FLEETADLC_SKILLS_ROOT', '$root/assets/skills'],
      ['FLEETADLC_ROLES_ROOT', '$root/assets/roles'],
      ['FLEETADLC_RUNNER_BUNDLE', '$root/assets/skill-runner.bundle.mjs'],
      ['FLEETADLC_GH_SHIM_DIR', '$root/assets/gh-shim'],
    ]) {
      expect(prepare).toContain(`\n      ${name}=${path}\n`);
    }
    expect(prepare).not.toMatch(/FLEETADLC_(SKILLS_ROOT|ROLES_ROOT|RUNNER_BUNDLE|GH_SHIM_DIR)=\$root\/app/);
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
    const grace = Number(/ExecStop=\/usr\/bin\/docker stop -t (\d+) fleet-hostd/.exec(hostdUnit)?.[1]);
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
