# Vorth — DMCA / Copyright Takedown Policy

**Status: TEMPLATE — not reviewed by an attorney.** In particular:
to have the DMCA §512 safe harbor actually apply to your platform in
the U.S., you generally need to **register a designated agent with
the U.S. Copyright Office** (via https://dmca.copyright.gov) and keep
that registration current — this document does not do that for you,
and using this policy without registering a designated agent will
not give you the legal protection the DMCA is meant to provide. Have
this reviewed by counsel, and complete the designated-agent
registration, before relying on it.

_Last updated: [DATE]_

## 1. Our policy

Vorth respects the intellectual property rights of others and expects
users of the Service to do the same. We respond to clear notices of
alleged copyright infringement that comply with the U.S. Digital
Millennium Copyright Act ("DMCA") or equivalent law in your
jurisdiction.

## 2. How to file a takedown notice

Submit a notice via `POST /api/dmca` (or the reporting form on the
site, if you build one against this endpoint) with the following
information, which the endpoint requires:

1. Your name, email, and (optionally) organization and address.
2. A description of the copyrighted work you claim has been
   infringed, and, where possible, a link to an authorized location
   of that work.
3. Identification of the material on Vorth you claim is infringing
   (series and/or chapter), specific enough for us to locate it.
4. A statement that you have a good-faith belief that the use of the
   material is not authorized by the copyright owner, its agent, or
   the law.
5. A statement, made under penalty of perjury, that the information
   in the notice is accurate and that you are the copyright owner or
   authorized to act on the owner's behalf.
6. Your physical or electronic signature (a typed full legal name is
   accepted).

Incomplete notices may be rejected or delayed while we request the
missing information.

## 3. What happens after you file

- Your notice is logged and queued for review by our moderation team.
- If we accept the notice, the identified series and/or chapter is
  removed from public view (soft-removed, not publicly visible, but
  retained internally for record-keeping). We record what was removed
  and why, so that any later counter-notice restores exactly that and
  nothing else.
- The publishing user is notified that their content was removed in
  response to a copyright claim.

## 4. Counter-notices

If your material was removed by mistake or misidentification, the
publishing user may file a counter-notice. Under DMCA §512(g) a
counter-notice must be a physical or electronic document signed by the
subscriber, and must state, under penalty of perjury:

1. the subscriber's name, address and email, so that process can be
   served on them;
2. the material that was removed or disabled, and the location where it
   was previously available;
3. that the subscriber has a good faith belief the material was removed
   as a result of mistake or misidentification; and
4. that the subscriber consents to the jurisdiction of the Federal
   District Court for the judicial district in which they reside or in
   which the alleged infringing activity was located, and will accept
   service of process from you.

A counter-notice is filed by the publishing user, without needing a
Vorth account, and is only available where an accepted notice actually
removed something. It can be filed once per takedown.

When you file a counter-notice we:

- forward it to you, with the subscriber's statements in full, as
  §512(g)(2)(A) requires; and
- start a **response window of 10 business days** from that forward.

If, within that window, you notify us that you have filed a court action
seeking to restrain the activity, we will keep the material removed. If
you do not, we may restore it. Restoration is not automatic and not
immediate: it happens through a reviewed sweep, and only for content
that is still removed because of *that* notice. If the content has since
been removed for another reason — a moderator decision, a Content Policy
report, or a court order — it stays down, and the sweep reports that it
declined to restore it and why.

The window is measured in business days, excluding weekends. Public
holidays are not excluded by default; a deployment can configure them
with `DMCA_COUNTER_NOTICE_HOLIDAYS`. The window defaults to 10 business
days, the earliest bound the statute allows, so the clock only ever runs
in your favour; it can be set up to 14 with `DMCA_COUNTER_NOTICE_DAYS`.

## 5. Repeat infringers

Consistent with the DMCA, Vorth will terminate, in appropriate
circumstances, the accounts of users who are determined to be repeat
infringers.

## 6. Misrepresentation

Under the DMCA, any person who knowingly materially misrepresents
that material is infringing, or was removed by mistake, may be liable
for damages.

## 7. Contact

Send takedown notices to: [DMCA_CONTACT_EMAIL] or via
`POST /api/dmca`.

Counter-notices are filed by the publishing user via
`POST /api/dmca/:id/counter-notice`, and are forwarded to you by email.

Designated agent (once registered with the U.S. Copyright Office):
[NAME / ADDRESS / EMAIL — fill in after registration]
