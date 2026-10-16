# SQL Injection Reference

This file is a source document for the deterministic seed compiler. It is an external, unverified reference and has no action policy.

## Concepts

SQL injection occurs at an application input-to-query boundary. Identify the input context and response behavior before selecting a verification method.

## Observation categories

Use bounded, authorized probes to distinguish context or quoting behavior, boolean comparison, error diagnostics, timing behavior, and result-shape checks. Transport success, HTTP status, visible success text, or an error message is an observation, not task success.

## Encoding and uncertainty

URL encoding is a client/server boundary. Distinguish a literal percent sequence from a real encoded byte and verify the received value. Keep true, false, transport failure, parser failure, and unknown separate. Preserve the exact input and response reference.

## Verification discipline

Use the smallest authorized read-only probe. When a candidate is ready, submit it for external review instead of exploring unrelated alternatives. This reference supplies terminology and experiment categories only; it is not a procedure, exploit, answer, authorization, or verified fact.
