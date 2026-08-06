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
  retained internally for record-keeping).
- The publishing user is notified that their content was removed in
  response to a copyright claim.
- [If you want to support formal DMCA counter-notices, add that
  process here — the current backend does not implement a
  counter-notice endpoint; you would need to add one, including the
  10–14 business day statutory waiting period before restoring
  content per DMCA §512(g).]

## 4. Repeat infringers

Consistent with the DMCA, Vorth will terminate, in appropriate
circumstances, the accounts of users who are determined to be repeat
infringers.

## 5. Misrepresentation

Under the DMCA, any person who knowingly materially misrepresents
that material is infringing, or was removed by mistake, may be liable
for damages.

## 6. Contact

Send takedown notices to: [DMCA_CONTACT_EMAIL] or via
`POST /api/dmca`.

Designated agent (once registered with the U.S. Copyright Office):
[NAME / ADDRESS / EMAIL — fill in after registration]
