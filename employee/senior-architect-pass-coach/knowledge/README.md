# Approved public source boundary

This directory contains public provenance metadata only. It deliberately contains no copied questions, answer keys, explanations, essay samples, user records, or private material.

The single approved public reference and its pinned revision are declared in `sources.json`. The repository URL is a reference, not evidence that its contents were loaded for a run. A host or trusted outer service may provide a bounded excerpt through the input contract's `approved_materials`; only those injected excerpts may be treated as source text for that run.

Rules:

1. Keep the employee package safe to publish and credential-free.
2. Do not mirror or silently ingest the referenced repository.
3. Do not claim a question's year, frequency, answer, or provenance unless the relevant approved excerpt is present in the request.
4. Keep personal progress outside this package. The model may return proposal-only events; an authenticated outer service owns validation and persistence.
5. Synthetic eval fixtures are contract examples, not exam material.
