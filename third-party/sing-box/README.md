# sing-box — bundled third-party component

MagicProxy bundles **sing-box**, an open-source universal proxy platform, as its
networking core. MagicProxy itself does not implement any proxy protocol; sing-box does
all of the actual network work.

| | |
|---|---|
| **Project** | sing-box by SagerNet |
| **Upstream** | https://github.com/SagerNet/sing-box |
| **Bundled version** | **v1.13.16** |
| **Licence** | GPL-3.0-or-later, plus an additional naming clause (see `LICENSE`) |
| **Copyright** | Copyright (C) 2022 by nekohasekai &lt;contact-sagernet@sekai.icu&gt; |

## Corresponding source

sing-box is licensed under the GNU General Public License v3.0 or later. Because
MagicProxy distributes the sing-box binary inside its installer and portable archive,
GPLv3 §6 requires that the corresponding source code be made available to you.

**The complete corresponding source for the exact version bundled here is available at:**

> https://github.com/SagerNet/sing-box/tree/v1.13.16
>
> Source archive: https://github.com/SagerNet/sing-box/archive/refs/tags/v1.13.16.tar.gz

Every MagicProxy release links to the source archive for the exact sing-box version that
release contains, from the same release page, at no charge.

If you later update the core from inside MagicProxy ("Check for updates"), the newer
binary is downloaded directly from SagerNet's own release page — that copy is conveyed
to you by SagerNet, and its corresponding source is published alongside it there. This
directory continues to describe the version originally bundled with your MagicProxy
release.

If that link is ever unreachable, contact magicmaxlabs@gmail.com and the corresponding
source will be provided by another means at no charge.

## Licence texts in this directory

- `LICENSE` — sing-box's own licence notice, including the additional clause
- `GPL-3.0.txt` — the full text of the GNU General Public License v3.0

## Relationship to MagicProxy's own licence

MagicProxy's own code (the browser extension and the native messaging host) is licensed
under the MIT Licence and is **not** a derivative work of sing-box. MagicProxy launches
sing-box as a separate operating-system process and communicates with it through a
generated configuration file — it does not link against sing-box, embed its code, or
combine with it into a single program. The two are aggregated, not combined.

## No affiliation

MagicProxy is not affiliated with, endorsed by, or associated with sing-box or SagerNet.
Per sing-box's additional licence clause, MagicProxy does not use the sing-box name to
imply any such association. sing-box is used here as an independent upstream component,
distributed unmodified.
