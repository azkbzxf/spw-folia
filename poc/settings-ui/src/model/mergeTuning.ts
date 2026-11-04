/* Defaults-first tuning merge (issue #18 item 1).
 *
 * Folia's `defineVisualizerTuning(...).apply` is `(props, tuning) => ({ ...props, temperaTuning: tuning })`
 * — it stores the bag it is handed **verbatim** and never runs the style's own `resolve()`. A style
 * renderer that multiplies by a key missing from that bag therefore computes `undefined` → NaN, and
 * a NaN `position` / `alpha` / `scale` does not throw: it silently drops the whole composition
 * (凝彩 became "background grain only" exactly that way when Folia 0.7.25 added
 * `depthOfField` / `depthPan` / `glyphDepth` to `TemperaTuning` and every settings tree persisted
 * before that release lacked the three keys).
 *
 * So the persistence layer merges "defaults first, persisted values on top", per style, instead of
 * the whole-object replacement it used to do. Shallow merge is the right granularity here: a tuning
 * value is a flat scalar or an array (`layerImages`), and an array present in the tree must replace
 * the default as a whole — never be spread element-wise, or the user's images would be padded by the
 * default `[]`.
 *
 * Pure on purpose (no imports, no side effects) so `packaging/tools/verify-tuning-merge.mjs` and any
 * other Node-side tool can load this file directly and drive the real merge logic.
 */

/** One style's (or one background's) tuning bag: flat scalars plus the occasional array. */
export type TuningBag = Record<string, unknown>;

/** A tuning tree keyed by style / background mode. */
export type TuningMap<Mode extends string> = Record<Mode, TuningBag>;

const isTuningBag = (value: unknown): value is TuningBag =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Merges one tuning bag: `defaults` under, the persisted bag on top.
 *
 * [persisted] wins over [current] whenever it is a real object, which is what "the tree is the
 * truth" means. [current] is only consulted when the tree carries no entry for this style at all —
 * so a payload that omits a style cannot silently reset the user's live edits of that style to the
 * defaults, which is what the previous `{ ...state, ...snapshot }` did not do either.
 *
 * Keys the tree does not carry fall back to `defaults`; that is the whole fix — a tree persisted
 * before a new upstream tuning key existed still yields a complete bag.
 */
export const mergeTuning = (
    defaults: TuningBag | undefined,
    persisted?: unknown,
    current?: unknown,
): TuningBag => {
    const overlay = isTuningBag(persisted) ? persisted : current;
    const merged: TuningBag = { ...(defaults ?? {}) };
    if (isTuningBag(overlay)) Object.assign(merged, overlay);
    return merged;
};

/**
 * Merges every style (or background mode) in [defaults]: each entry is [`mergeTuning`].
 *
 * Modes the persisted tree knows but this build's `defaults` do not are carried over untouched — a
 * newer page or a modded build must not lose its data just because this build predates the key.
 */
export const mergeTuningMap = <Mode extends string>(
    defaults: TuningMap<Mode>,
    persisted?: Partial<Record<Mode, unknown>> | null,
    current?: Partial<Record<Mode, unknown>> | null,
): TuningMap<Mode> => {
    const merged = {} as TuningMap<Mode>;
    for (const mode of Object.keys(defaults) as Mode[]) {
        merged[mode] = mergeTuning(defaults[mode], persisted?.[mode], current?.[mode]);
    }
    const extra: Record<string, TuningBag> = {};
    for (const [mode, value] of Object.entries(persisted ?? {})) {
        if (Object.prototype.hasOwnProperty.call(merged, mode)) continue;
        const carried = isTuningBag(value) ? value : current?.[mode as Mode];
        if (isTuningBag(carried)) extra[mode] = { ...carried };
    }
    return Object.keys(extra).length === 0 ? merged : ({ ...merged, ...extra } as TuningMap<Mode>);
};
