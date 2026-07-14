# Reverb clean-room verification log

The Phase 5 implementation gate uses `npm run verify:reverb-clean-room` after
building the first-party bundle. The verifier proves that the approved,
Git-tracked evidence record still names the required pinned public-domain
README and response hash, has reviewer sign-off, and scans the authored source
and distributed bundle for prohibited Freeverb3/GPL/LGPL material.

The production notice retains attribution and exclusion language separately;
that audit language is not part of the executable source scan.
