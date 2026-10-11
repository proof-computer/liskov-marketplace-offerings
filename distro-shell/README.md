# Debian 13 shell

This is the public source for a disposable Debian 13 arm64 Linux shell on a
residential phone. The draft application runs one box for four hours, reached
through Liskov managed SSH using the organization's operator keys and a plan
that permits managed SSH. Placement specifies minimum memory and storage;
it does not reserve dedicated hardware.

The shell runs under PRoot. There is no root access, systemd, Docker or TUN
device. Traffic is outbound only, with no public or private ingress. There is
no persistent disk: the root filesystem resets when the processor restarts
the sandbox. This source is a draft for the Debian Marketplace listing; a live
listing and successful SSH launch are separate person-led steps.

## Supervisor and startup

The standard-library-only Rust binary `liskov-shell` is built for AArch64 MUSL
and installed at `/usr/local/bin/liskov-shell`.

It creates `/tmp` and exports `TMPDIR=/tmp`. An optional nonempty
`LISKOV_SHELL_STARTUP` is written verbatim to `/tmp/liskov-shell-startup.sh`
and executed with `/bin/sh`. The script child has `LD_PRELOAD` removed so
apt and dpkg work; the supervisor retains its own inherited environment.
The script's stdout and stderr stream to stdout with a `shell.startup`
prefix. Long lines are split into chunks of at most 4096 bytes.

`LISKOV_SHELL_STARTUP` is plain configuration, visible on the Variables page.
Never put credentials or other secrets in it or in its output.

The supervisor logs `shell.startup.exit=<code>` on exit (128 plus the signal
number for a signal exit). A write, spawn or wait failure logs
`shell.startup.error`. A script still running after 30 minutes logs
`shell.startup.timeout` and is left running; its eventual exit is still logged.
An empty or unset script is skipped. After completion, failure or timeout,
the supervisor logs `shell.ready` and then `shell.heartbeat` every 60 seconds
forever. Script failure never takes down the supervisor or prevents SSH access.

## Source template and build

`debian-13-shell.v5.json` is a V5 source document (`release.mode: source`)
with no invented artifact digest. Its image reference is
`liskov-runtime-images/debian-trixie/0.1`, its entrypoint is the supervisor,
state is off and logs are on. The four-hour draft requests minimums of 4 GiB
memory and 8 GiB storage.

The draft spend cap is 1,200,000 service-credit micros per job, with a rate
cap of 3,000,000 per day. These are draft guardrails derived from the existing
two-hour lab template (doubling its per-job cap); the person publishing the
listing must choose and verify the final length caps before launch.

`.github/workflows/debian-13-shell.yml` only runs by manual dispatch. It uses
the released `cargo-runtime-image.yml@v2` V5 build path, source assurance and
runtime image attestation. The supervisor is composed over the exact promoted
Debian trixie snapshot from `v0.1.0-rc.13`, pinned by its URL, SHA-256 and
attestation identity in the workflow. The toolchain is pinned to Rust 1.95.0.

Before dispatch, the person responsible for BKLG-20261008-kj3r must register
the build application and set its id in the workflow and source document
(the draft uses `debian-13-shell`). They must set its source binding with
`proof liskov application source-binding set` for this repository, source
manifest and workflow (ADR-0068). They then dispatch the build and retain its
real artifact digest, source digest, SBOM, provenance and binding outputs for
V5 source publication and the `proof/debian-13-shell.json` listing. This
packet creates no Marketplace entry and performs no live build or publication.

## Local checks

Run from the repository root, using the pinned toolchain
(`RUSTUP_TOOLCHAIN=1.95.0`):

```sh
cargo fmt --manifest-path distro-shell/Cargo.toml --check
cargo clippy --locked --manifest-path distro-shell/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path distro-shell/Cargo.toml
jq empty distro-shell/debian-13-shell.v5.json
proof liskov application manifest validate --file distro-shell/debian-13-shell.v5.json --json
```

Tests use an isolated supervisor process and a fake shell, with injectable
startup deadlines and heartbeat intervals. The ignored `supervisor_fixture`
test is the subprocess entrypoint invoked by the integration tests, not an
omitted acceptance test.

Regenerate `sbom.cdx.json` with `actions/source-assurance/sbom.py` from the
released Actions SHA `2eef49238a02a0a17824abf9c697935aa73f5734`:

```sh
python3 <liskov-github-actions>/actions/source-assurance/sbom.py --directory distro-shell
git diff --exit-code -- distro-shell/sbom.cdx.json
```

The SBOM lists Cargo lockfile packages. There are no external crate
dependencies; the Rust standard library comes from the pinned toolchain.
The source and license are public under Apache-2.0 (ADR-0106, ADR-0212).
