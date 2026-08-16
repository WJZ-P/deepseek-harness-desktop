# Agent Note: Model settings expose additive row fields through a child slot

Status: implemented

English | [中文](2026-08-16-model-settings-field-extension-slot.zh.md)

## Problem

The Models page preserves unknown properties on a pi-ai model entry but renders only id, display name, context window, and output limit. A feature that owns another adapter-supported property therefore has persistence but no composition point: it must replace the complete Models section, import the editor's implementation, or modify the built-in form. Each option couples an independent capability to provider discovery, credentials, validation, and settings-conflict handling that the Models package already owns.

Input modalities expose the gap directly. `llm-pi-ai` accepts a per-model `input` declaration, and the conservative fallback is text, but the built-in form intentionally stays narrow. A separately distributed capability editor needs to edit that existing draft without taking ownership of the provider write.

## Decision

The Models section declares the root-scoped list slot `settings.models.model.fields`. Its render site is inside each pi-ai model row's advanced disclosure, after the two built-in capacity fields. The slot is additive, so independent field plugins use distinct ids and render in order without shadowing the built-in form or one another.

The owner share contains the complete row draft, its zero-based index, the editor's disabled state, and an `update(patch)` callback. The callback merges keys into the addressed row and removes a key whose patch value is `undefined`; the existing model-list update remains the only path that rebuilds the row. The Models page continues to validate and persist the complete `models` array through its existing settings mutation.

`ModelsSection` owns `renderSlot` authority and delegates a narrower `ModelFieldRenderer` callback through the provider editor and custom-provider card. Descendants receive no registry or context object. The slot exists only while the Models section entry is registered, and contributors use `ctx.slots.inject` so activation order remains independent.

The built-in Models package contributes no occupant. Product compositions choose which additional model properties they expose, while the core editor remains focused on common provider fields.

## Alternatives considered

- **Add `input` directly to the built-in editor** — this solves one property but makes the provider form own every capability that later needs presentation. It also reverses the deliberate narrow-form decision instead of creating an extension point.
- **Replace `settings.section` with a richer Models page** — this duplicates provider joins, credential handling, discovery, validation, and conflict-safe persistence, and a replacement misses future fixes in the original page.
- **Inject controls through DOM observation** — a DOM observer has no typed draft or patch path and depends on private markup, so it either writes settings out of band or simulates user interaction.
- **Pass the slot registry into model components** — components would gain framework context and render authority beyond this one child slot, contrary to the four-share slot model. Delegating the authorized render function keeps that authority with `ModelsSection`.

## Consequences

An external browser plugin can edit a model property with a small presentation component and does not import the Models implementation. The persistence path keeps unknown fields, settings revisions, and validation behavior unchanged. The shared Harness change is one typed slot declaration, one render site, and plain callback delegation through existing components.

The slot currently appears only for pi-ai model rows because `ModelListEditor` is the editor whose rows are structurally open and whose adapter schema owns model-level capabilities. The DeepSeek-specific catalog editor retains its adapter-defined text-only behavior.

## Testing

The Models apply test verifies the child-slot runtime specification. The provider-form test renders a contributed field through the full delegation path, applies an array-valued patch, and observes that the existing settings mutation persists it in the addressed model row. The generated client slot catalog records the public owner share and declaration site.
