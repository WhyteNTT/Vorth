# Vorth — Content Policy

**Status: TEMPLATE — not reviewed by an attorney.** Have it reviewed
by counsel, particularly the enforcement and appeals sections, before
launch.

_Last updated: [DATE]_

This policy covers what may and may not be published or posted on
Vorth, separate from copyright (see Copyright Guidelines and DMCA
Policy).

## 1. Prohibited content

The following is never permitted on Vorth, in series, chapters,
covers, or comments — no exceptions:

- Content that sexualizes minors in any way, including fictional
  depictions, regardless of medium (text, illustration, AI-generated).
  This is enforced strictly and reported to the relevant authorities
  where required by law.
- Content that facilitates, depicts, or promotes child grooming or
  exploitation.
- Non-consensual intimate imagery of real people.
- Content that promotes or provides instructions for terrorism,
  violent extremism, or mass harm.
- Content that harasses, threatens, or incites violence against a
  person or group, including on the basis of a protected
  characteristic (race, religion, gender, sexual orientation,
  disability, etc.).
- Malware, phishing links, or content designed to compromise readers'
  devices or accounts.
- Content that infringes another party's copyright or trademark (see
  Copyright Guidelines).

## 2. Age-gated content

Vorth [decide your platform's policy: does it allow mature content
behind an age gate, or is it all-ages only?]. If you allow mature
content:

- Series must be accurately tagged (e.g. a "Mature" or content-warning
  tag) at publication.
- [Describe the enforcement mechanism — age verification, content
  warnings, default-off visibility for unverified accounts, etc.]

## 3. Enforcement

- Content that violates this policy may be removed without notice.
- Accounts that repeatedly or severely violate this policy may be
  suspended or terminated.
- Content involving child sexual abuse material (CSAM) is removed
  immediately, the account is permanently terminated, and — where we
  are legally required to — reported to the National Center for
  Missing & Exploited Children (NCMEC) or the equivalent authority in
  your jurisdiction. [Confirm your specific legal reporting
  obligations with counsel — these vary by jurisdiction and may be
  mandatory rather than discretionary.]

## 4. Reporting content

Content that violates this policy can be reported through
`POST /api/reports`. The report takes a category, a short description, an
optional longer detail, and a reference to the series, chapter or comment being
reported.

The categories correspond one-for-one to the prohibited-content list in
section 1:

| Category | Use for |
|---|---|
| `sexual_minors` | Any sexualisation of minors, including fictional depiction |
| `child_safety` | Child grooming or exploitation |
| `non_consensual_intimate` | Non-consensual intimate imagery of real people |
| `violent_extremism` | Terrorism, violent extremism, instructions for mass harm |
| `hate_harassment` | Harassment, threats or incitement, including on a protected characteristic |
| `malware_phishing` | Malware, phishing, or links that would compromise a reader's device |
| `copyright_or_trademark` | Copyright or trademark infringement |
| `other` | Anything the list above does not cover |

No account is required. Supplying an email address is optional, but it is how
we tell you the outcome.

**Copyright and trademark claims have a separate, formal route.** Use the DMCA
notice at `POST /api/dmca` instead. That form carries the statutory elements -
good-faith and accuracy statements, and a signature - which a policy report does
not ask for and cannot act on. A report filed under
`copyright_or_trademark` is triaged and then routed to that formal process; it
is not a substitute for it.


## 5. Appeals

[Describe how a user can appeal a moderation decision, and the
timeline for review.]

## 6. Relationship to other policies

This Content Policy works alongside the Terms of Service, Copyright
Guidelines, and DMCA Policy. Where they overlap, all apply.
