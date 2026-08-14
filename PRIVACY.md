# Privacy Policy — MagicProxy

**Last updated: 14 August 2026**

## Short version

MagicProxy has no servers, no accounts, no telemetry and no analytics. The
developers never receive any of your data, because there is nowhere for it to be
sent. Everything below describes what the software handles **locally, on your own
computer**.

## What the software handles

**Proxy server configuration that you enter.** Server addresses, ports, UUIDs,
passwords, pre-shared keys and similar values. This is authentication information.
It is stored locally in your browser profile (`chrome.storage.local`), it is **not**
synced to your Google account, and it is sent only to the MagicProxy background
component running on the same computer, which needs it to configure the networking
core.

**Your on/off state and routing rules.** Stored locally in the same way.

**Diagnostic log lines produced by the networking core.** Kept in memory for display
in the extension popup. Not written to disk by the extension, and not transmitted.
The core runs at a log level that does not record the sites you visit.

**A generated core configuration file.** While the proxy runs, the background
component writes a configuration file containing your server details to a temporary
directory on your computer. It is removed when you uninstall.

## What is never collected

No browsing history. No page contents. No URLs. No cookies. No form data. No
identifiers. No usage statistics. No crash reports.

The extension declares **no host permissions** and injects no scripts into web
pages. Its permissions are limited to `proxy`, `privacy`, `storage`,
`nativeMessaging` and `alarms`. The `privacy` permission is used for exactly one
thing: while the proxy is on, the profile's WebRTC policy is set to
`disable_non_proxied_udp` so WebRTC cannot leak your real IP address around the
tunnel; the policy is removed when the proxy is switched off. No data is read
through this API.

## Network connections the software makes by design

1. **To the proxy server you configure.** That server carries your traffic and sees
   your IP address and your destinations. We have no relationship with it — choose a
   server you trust.
2. **To GitHub**, only if you use the optional "check for core updates" function.
   GitHub sees your IP address for that request. The installer itself downloads
   nothing; the networking core is bundled.

That is the complete list. The software contacts no other host.

## Limited Use disclosure

Our use of information received from Google APIs adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
including the Limited Use requirements.

## Data deletion

Removing the extension deletes its local storage, including your server profiles.
Uninstalling the background component removes its files and its temporary
configuration. There is no server-side data to delete, because there is no server.

## Changes to this policy

Material changes will be noted in the project's `CHANGELOG.md` and in the release
notes, and this date will be updated.

## Contact

**magicmaxlabs@gmail.com** · https://github.com/MagicMaxLabs/MagicProxy/issues
