# Rust hello world for Liskov

This is a public, deliberately unlisted Cargo runtime-image example. There is
no file for it under `proof/`, so it is not a Marketplace offering or an
admittance claim.

The program prints a greeting and one output line every ten seconds while it
remains alive. The checked-in application manifest uses no SSH ingress and does
not opt into local restart policy.

## Build

`Cargo.lock` and `rust-toolchain.toml` are committed. The reusable workflow
builds the static AArch64 MUSL binary twice, overlays both builds independently
on the exact attested helperless rootfs, and requires identical image bytes
before upload and finalization.

```sh
cargo build --release --locked --target aarch64-unknown-linux-musl
```

The workflow remains manual while the Debian rootfs and native supervisor are
in release qualification. Dispatching it can create Liskov artifacts; it does
not deploy the application.

## Supervisor restart canary

The internal canary may set
`LISKOV_HELLO_CANARY_FAIL_ONCE_FILE=/tmp/liskov-hello-failed-once`. The first
attempt atomically creates that absolute marker and exits 42; the next exact
argv attempt observes it and stays alive. The normal manifest does not declare
or set this variable.

## Customer-owned Tailscale fragment

The normal example has `"ingress": {}`. After Runtime SSH reaches private
preview, an authorized policy may instead use the typed provider fragment:

```json
{
  "ingress": {
    "ssh": {
      "mode": "required",
      "provider": {
        "kind": "tailscale",
        "integrationId": "int_...",
        "port": 22
      }
    }
  }
}
```

This is bring-your-own Tailscale: the organization connects and pays for its
own account and tailnet, supplies its own OAuth client, owns tag grants and
Tailscale SSH policy, and remains responsible for user identity and audit.
Liskov does not provide, select, or switch to a managed tailnet. The fragment is
documentation only until the private-preview control plane is released.
