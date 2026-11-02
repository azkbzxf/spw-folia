// RenameSim.java — negative test: after an R8 rename, name-pinned lookups fail and the resolver must
// never invent a role assignment.
//
// WHY THIS EXISTS
// ---------------
// The Steam workshop post by Salt Player's official developer (GaodaGG, 2025-10-20) warns that SPW's
// obfuscated class/method names are regenerated on every build, so a plugin that pins them breaks with
// ClassNotFoundException / NoSuchMethodException as soon as the player updates. `FoliaPlaybackControls`
// is now metadata-first with the pinned ids as a fallback; `VerifyResolver2` proves the positive path
// against a real host archive.
//
// What a positive test cannot show is what happens when BOTH fail — i.e. a host whose metadata is
// stripped AND whose pinned ids are gone. That is what this simulates, and the required behaviour is
// specific:
//
//   * the pinned-id lookups must MISS (they cannot work after a rename), and
//   * the structural resolver must either return the CORRECT pairing or return NOTHING.
//
// It must never return a *wrong* pairing. During development of this change, two plausible designs
// (bucketing getters by return type and zipping them against the metadata names, and pairing
// "i-th List field with i-th List getter" over `getDeclaredMethods()` order) both silently swapped
// normal/random on real host bytecode — users would see the shuffle queue rendered as the sequential
// one. This test locks in the "refuse rather than guess" contract: when accessor names do not match
// field names, `listIntPairs` returns an empty list and the caller falls through to its own fallback.
//
// Self-contained: no host archive needed, no classpath beyond the plugin classes + kotlin-stdlib.
//
// USAGE (from the repo root)
//   JH="C:/Program Files/Java/jdk-25.0.2"
//   KS=$(find ~/.gradle -name 'kotlin-stdlib-2*.jar' | head -1)
//   CP="spw-folia/build/classes/kotlin/main;spw-folia/build/classes/java/main;$KS"
//   "$JH/bin/javac" -cp "$CP" -d poc/webview/host/repro/out poc/webview/host/repro/RenameSim.java
//   "$JH/bin/java" -cp "poc/webview/host/repro/out;$CP" RenameSim
//
// EXPECTED OUTPUT
//   "PASS  renamed build: pinned lookups fail, and the resolver refuses to guess (no silent mis-pairing)"
//   exit code 0.

import dev.spw.folia.HostMemberResolver;
import java.lang.reflect.Method;
import java.util.List;

public final class RenameSim {

    /**
     * Shape of the obfuscated queue state, with identifiers that exist on no real build.
     *
     * The field table still carries the data-class component order (mode, queue, index, queue, index,
     * bool) — that is what a real R8 output looks like — but the accessor names deliberately do NOT
     * match the field names, which is the situation the resolver must refuse to guess through.
     */
    public static final class FakeQueueState {
        private final String mode = "Random";
        private final List<String> queueA = List.of("a", "b");
        private final int indexA = 1;
        private final List<String> queueB = List.of("b", "a");
        private final int indexB = 0;
        private final boolean ready = true;

        public String modeGetter() { return mode; }
        public List<String> zz1() { return queueA; }
        public int zz2() { return indexA; }
        public List<String> zz3() { return queueB; }
        public int zz4() { return indexB; }
        public boolean zz5() { return ready; }
    }

    public static void main(String[] args) {
        Class<?> state = FakeQueueState.class;
        System.out.println("=== simulated build: pinned ids renamed away, accessor/field names diverge ===");

        // 1. Every pinned id the old code relied on is gone.
        boolean pinsAbsent = findByName(state, "\u037F") == null && findByName(state, "\u0528") == null
                && findByName(state, "\u0529") == null && findByName(state, "\u052A") == null
                && findByName(state, "\u052B") == null;
        System.out.println("       pinned ids absent: " + pinsAbsent);

        // 2. The structural resolver must decline, not guess.
        List<?> pairs = HostMemberResolver.INSTANCE.listIntPairs(state);
        System.out.println("       listIntPairs -> " + pairs.size() + " pair(s)"
                + (pairs.isEmpty() ? "  (declined: names do not match, so no role can be assigned safely)" : ""));
        for (Object p : pairs) {
            kotlin.Pair<?, ?> pp = (kotlin.Pair<?, ?>) p;
            System.out.println("         " + ((Method) pp.getFirst()).getName()
                    + " + " + ((Method) pp.getSecond()).getName());
        }

        boolean ok = pinsAbsent && pairs.isEmpty();
        System.out.println();
        System.out.println(ok
                ? "PASS  renamed build: pinned lookups fail, and the resolver refuses to guess (no silent mis-pairing)"
                : "FAIL  unexpected result: pinsAbsent=" + pinsAbsent + " pairs=" + pairs.size()
                        + " (a non-empty pairing here would mean roles were invented)");
        System.exit(ok ? 0 : 1);
    }

    static Method findByName(Class<?> t, String n) {
        for (Method m : t.getDeclaredMethods()) {
            if (m.getName().equals(n) && m.getParameterCount() == 0) return m;
        }
        return null;
    }
}
