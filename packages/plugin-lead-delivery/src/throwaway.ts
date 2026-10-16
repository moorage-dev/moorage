// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

/**
 * Throwaway (disposable) email domains: the common public services. A flagged
 * enquiry is still delivered; the flag only says so in the log, and in HubSpot
 * when the owner asks for it.
 */
const DOMAINS = `
0-mail.com 10minutemail.com 10minutemail.net 20minutemail.com 33mail.com 7tiqqxsfmd2qx5.cf
anonaddy.me anonbox.net armyspy.com binkmail.com bobmail.info boximail.com burnermail.io
byom.de chacuo.net cuvox.de dayrep.com deadaddress.com discard.email discardmail.com
discardmail.de dispostable.com dodgit.com dropmail.me dudmail.com einrot.com emailondeck.com
emailsensei.com emailtemporanea.com emailtemporanea.net emltmp.com fakeinbox.com fakemail.net
fakemailgenerator.com fastacura.com filzmail.com fleckens.hu getairmail.com getnada.com
gishpuppy.com grr.la guerrillamail.biz guerrillamail.com guerrillamail.de guerrillamail.info
guerrillamail.net guerrillamail.org guerrillamailblock.com gustr.com harakirimail.com
hidemail.de inboxbear.com inboxkitten.com incognitomail.org jetable.org jourrapide.com
kasmail.com koszmail.pl kurzepost.de lroid.com mail-temp.com mail.tm mail7.io mailcatch.com
maildrop.cc mailexpire.com mailforspam.com mailinator.com mailinator.net mailinator2.com
mailnesia.com mailnull.com mailpoof.com mailsac.com mailtemp.info mailtothis.com mintemail.com
moakt.com mohmal.com mt2015.com mvrht.com mytemp.email mytrashmail.com nada.email
nospam.ze.tc nwldx.com one-time.email oneoffemail.com pokemail.net proxymail.eu rcpt.at
rhyta.com sharklasers.com shitmail.me sneakemail.com sogetthis.com spam4.me spamavert.com
spambog.com spambox.us spamex.com spamfree24.org spamgourmet.com spamhole.com spamify.com
spaml.de spammotel.com superrito.com suremail.info tafmail.com teleworm.us temp-mail.io
temp-mail.org tempail.com tempemail.net tempinbox.com tempmail.dev tempmail.net
tempmail.plus tempmailaddress.com tempmailo.com tempr.email temporaryemail.net
temporaryinbox.com thankyou2010.com throwam.com throwawaymail.com tmail.ws tmailinator.com
tmpmail.net tmpmail.org trash-mail.com trash-mail.de trashmail.com trashmail.de trashmail.me
trashmail.net trashmailer.com trbvm.com wegwerfmail.de wegwerfmail.net wegwerfmail.org
yopmail.com yopmail.fr yopmail.net zetmail.com
`
	.split(/\s+/)
	.filter(Boolean);

const SET = new Set(DOMAINS);

export function isThrowaway(email: string | undefined): boolean {
	const domain = email?.split("@")[1]?.toLowerCase();
	return domain ? SET.has(domain) : false;
}

export const THROWAWAY_COUNT = SET.size;
