# Clean-room evidence: Orbitronica reverb

## Scope and allowed input

This record is the pre-code evidence boundary for `orbitronica-reverb`.  The
only external technical input retained for this implementation is the
commit-pinned original Freeverb README listed below.  It identifies the
algorithm as Jezar/Dreampoint's public-domain work and describes its
Schroeder/Moorer-style signal topology.

The implementation author may use this record and that pinned README.  It
must not consult mutable web pages, Freeverb3, or GPL/LGPL ports/repositories.
No impulse response, network retrieval, or runtime external asset is part of
the permitted design.

## Source retrieval record

| Source role | Exact retrieval URL | Retrieved (UTC) | Response SHA-256 | Extraction method |
| --- | --- | --- | --- | --- |
| Original algorithm description and public-domain grant | `https://browse.dgit.debian.org/snd.git/plain/freeverb-readme.txt?id=85fd86a014b40219a63ae1016955f87c37a27b5d` | 2026-07-14T06:54:31Z | `a7c89f728a4e7a1fa6403c178d8d04f5616e12ef93ffea9ecdc432ca91641851` | HTTPS retrieval of the pinned plain-text response; SHA-256 computed over the response bytes; facts below manually paraphrased from its technical and licensing sections. |

The observed hash equals the PRD/test-spec expected value
`a7c89f728a4e7a1fa6403c178d8d04f5616e12ef93ffea9ecdc432ca91641851`.

## Paraphrased topology and tuning facts

| Topic | Permitted fact for the new implementation | Provenance |
| --- | --- | --- |
| Algorithm attribution | Attribute the original public-domain algorithm to Jezar at Dreampoint; retain that attribution in the plugin notice/source notes. | Pinned README retrieval above |
| Core topology | Build each stereo side from eight parallel feedback-comb paths, then pass their summed result through four serial all-pass diffusion paths. | Pinned README retrieval above |
| Stereo treatment | Use distinct left/right delay choices so the two wet outputs are decorrelated rather than simple copies. | Pinned README retrieval above |
| Diffusion count | Keep four serial diffusion stages: fewer is expected to sound coarser, while more is not required by the reference description. | Pinned README retrieval above |
| Base-rate convention | Treat 44.1 kHz as the reference-rate convention required by the project PRD; scale every newly selected delay duration by the active sample rate and clamp it to a valid nonzero delay. | Pinned README retrieval above for the algorithm family; project PRD FR-6 for the rate-scaling rule |
| Numeric tap values | The pinned README says tuned values exist but does **not** publish numeric tap constants.  This record deliberately supplies none.  Any concrete tap values must be independently selected in newly authored code, documented as Orbitronica design constants, and tested at 44.1/48 kHz; they are not extracted from a derivative port. | Pinned README retrieval above |

## Clean-room review and sign-off

Research/license reviewer sign-off (2026-07-14): I checked this artifact
against the pinned-response hash and its stated source boundary.  It contains
only source identity, public-domain attribution, paraphrased topology/tuning
facts, and retrieval metadata.  It contains no implementation code,
pseudocode, copied source passages, or material from Freeverb3 or GPL/LGPL
derivative ports.  The required file is intended to remain Git-tracked before
any reverb implementation commit.

Known limitation: the original pinned README is descriptive rather than a
numeric tuning table.  It therefore supports an original implementation but
does not authorize recovering or copying unlisted tap constants from another
implementation.
