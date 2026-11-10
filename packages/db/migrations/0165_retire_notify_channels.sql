-- ntfy, Slack and the webhook are retired (#281,
-- docs/adr/0049-push-is-the-only-notification-channel.md): push to the
-- console app is the only notification channel.
--
-- Their targets are in the secret store, which SQL cannot reach: the bridge
-- deletes `notify-target` and `notify-target:person:*` at start. A bridge of
-- the release before this one, still running while it applies, reads no
-- channel and sends to none.
delete from settings where key in ('notifyTransport', 'personNotify');
