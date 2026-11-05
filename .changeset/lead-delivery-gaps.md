---
"@moorage/plugin-lead-delivery": patch
---

Safer app addresses: Lead Delivery now refuses every address on a private network, not only the common ones. Newly refused: 172.16.0.0 to 172.31.255.255, 0.0.0.0, 100.64.0.0/10 (carrier-grade NAT), other reserved ranges, IPv6 unique-local (`fc00::/7`) and link-local (`fe80::/10`) addresses and IPv4 inside IPv6, and the same addresses written as one number, in hex or in octal (`2130706433`, `0x7f.1`). Public IPv6 addresses are now accepted. The check also runs before every send, so an app delivery saved earlier with such an address is no longer sent: it shows as needing fixing, with the way to change it under Edit. Only Admins can enter or change a delivery's address.
