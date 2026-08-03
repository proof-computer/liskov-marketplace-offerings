# Managed Runtime SSH canary

This is the disposable Cargo workload for ADR-0045 live acceptance. It does not
contain access credentials or SSH configuration. The Liskov application is
private even though the non-secret workload and build provenance are public.

The existing `liskov-runtime-contact` helper sets up the canary-only managed
access adapter before starting this exact customer command. The process emits a
bounded heartbeat every 30 seconds and exits successfully after three hours if
the Acurast schedule does not terminate it first.
