// VerifyResolver2.java — prove the playback-queue reflection still resolves on a given SPW build.
//
// WHY THIS EXISTS
// ---------------
// SPW ships R8-obfuscated. The Steam workshop post by Salt Player's own developer (GaodaGG,
// 2025-10-20, "【插件开发建议】关于插件调用 Hook API 时的反混淆") says pinned obfuscated class/method
// names break on every player update, and that plugins must locate members through compilation-stable
// features (Kotlin @Metadata, parameter/return types, member layout) and cache the result.
//
// `FoliaPlaybackControls` used to pin five raw obfuscated identifiers for the queue model
// (\u037F, \u0528…\u052B). It now resolves them via `HostMemberResolver` (metadata property order +
// field-table order, with the pinned ids as last-resort fallback). This harness runs that resolver
// against a REAL host archive and asserts every role still lands on a distinct, correctly-typed member.
//
// Run this after every SPW upgrade. If it fails, the resolver fell back further than intended — read
// the failure text before touching the pinned constants.
//
// WHAT IT CHECKS
//   1. @Metadata still declares `mode, normalQueue, normalIndex, randomQueue, randomIndex` in order.
//   2. All five accessors resolve, and normal/random are DIFFERENT members (a silent swap here shows
//      up to users as "shuffle mode displays the sequential queue").
//   3. Queue getters return a collection, index getters return int.
//   4. The historical pinned ids resolve to the SAME members as the metadata path (i.e. on a build
//      where the pinned names still work, both strategies agree; when they disagree the metadata path
//      is the one to trust).
//   5. The queue element class (obfuscated single-char name) is found and exposes `id` (int) then
//      `data` (reference) from its metadata.
//   6. NEGATIVE: a renamed accessor is NOT reachable by its source getter name — this is the exact
//      failure mode name-pinning would hit, and it demonstrates why the metadata path is needed.
//
// DEPENDENCIES
//   * the plugin's compiled classes (HostMemberResolver + KotlinMetadata), i.e. `spw-folia/build/classes`
//   * kotlin-stdlib (for kotlin.Pair), from the Gradle cache
//   * the host archive you want to test
//
// HOST ARCHIVE ARGUMENT (required — never hardcode it; the library may live under Steam, MSIX, or a
// custom path, and reverse-engineering scripts that pin one path break on the next machine):
//   steam:  "<Steam>/steamapps/common/Salt Player for Windows/app/ffmpeg-x64.dll"
//   msix:   "%LOCALAPPDATA%/../Program Files/WindowsApps/Sakawish.SaltPlayerforWindows_*/app/ffmpeg-x64.dll"
// It is the polyglot ZIP that is the whole app classpath (~111 MB, ~42k entries).
//
// USAGE (from the repo root; on Windows use a ';' classpath)
//   JH="C:/Program Files/Java/jdk-25.0.2"
//   KS=$(find ~/.gradle -name 'kotlin-stdlib-2*.jar' | head -1)
//   CP="spw-folia/build/classes/kotlin/main;spw-folia/build/classes/java/main;$KS"
//   "$JH/bin/javac" -cp "$CP" -d poc/webview/host/repro/out poc/webview/host/repro/VerifyResolver2.java
//   "$JH/bin/java" -cp "poc/webview/host/repro/out;$CP" VerifyResolver2 "<host-jar>"
//
// EXPECTED OUTPUT
//   ten "PASS" lines followed by "10/10 passed"; exit code 0.
//   Any FAIL names the role and prints both members, so the offending lookup is obvious.
//
// NOTE ON SCOPE
//   This validates the *reflection layer* against real host bytecode. It does NOT render lyrics or
//   the queue UI: nothing in the repo can drive a live SPW playback queue end-to-end (see the M1
//   report — the plugin is not installable into a running SPW from here).

import dev.spw.folia.HostMemberResolver;
import java.io.File;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class VerifyResolver2 {

    static int pass = 0;
    static int fail = 0;

    static void check(String name, boolean ok, String detail) {
        System.out.println((ok ? "PASS  " : "FAIL  ") + name + "\n      " + detail);
        if (ok) pass++; else fail++;
    }

    /** Renders obfuscated identifiers readably (they are single non-ASCII code points). */
    static String clean(String s) {
        StringBuilder b = new StringBuilder();
        for (char c : s.toCharArray()) {
            if (c >= 32 && c < 127) {
                b.append(c);
            } else {
                b.append(String.format("U+%04X", (int) c));
            }
        }
        return b.toString();
    }

    public static void main(String[] args) throws Exception {
        if (args.length < 1) {
            System.err.println("usage: VerifyResolver2 <host-jar>");
            System.err.println("  e.g. <Steam>/steamapps/common/Salt Player for Windows/app/ffmpeg-x64.dll");
            System.exit(2);
        }
        File jar = new File(args[0]);
        if (!jar.isFile()) {
            System.err.println("host archive not found: " + jar.getAbsolutePath());
            System.err.println("pass the polyglot ZIP that SPW uses as its classpath (app/ffmpeg-x64.dll)");
            System.exit(2);
        }

        // Isolated loader: the host classes come only from this archive, exactly like inside SPW.
        URLClassLoader L = new URLClassLoader(new URL[] { jar.toURI().toURL() },
                ClassLoader.getSystemClassLoader().getPlatformClassLoader());

        String pkg = "com.xuncorp.spc.core.queue.";
        Class<?> state = Class.forName(pkg + "PlaybackQueueState", false, L);
        Class<?> mode = Class.forName(pkg + "PlaybackQueue$Mode", false, L);
        // The queue element's NAME is R8 output; it has been a single char for several releases, but
        // the harness does not depend on which one — it finds the class through the state's metadata.
        Class<?> item = findQueueItem(state, L, pkg);

        // ---- 1. metadata property order ----
        List<String> stateProps = HostMemberResolver.INSTANCE.metadataPropertyOrder(state);
        System.out.println("=== " + jar.getName() + " ===");
        System.out.println("PlaybackQueueState metadata property order:");
        System.out.println("   " + stateProps);
        check("metadata order starts with mode, normalQueue, normalIndex, randomQueue, randomIndex",
                stateProps != null && stateProps.size() >= 5
                        && stateProps.get(0).equals("mode")
                        && stateProps.get(1).equals("normalQueue")
                        && stateProps.get(2).equals("normalIndex")
                        && stateProps.get(3).equals("randomQueue")
                        && stateProps.get(4).equals("randomIndex"),
                String.valueOf(stateProps));

        // ---- 2. positional zip, same steps as resolveQueueStateMembers ----
        List<Method> modeGetters = HostMemberResolver.INSTANCE.matchByType(state, m -> {
            Class<?> r = m.getReturnType();
            return m.getParameterCount() == 0 && (mode.isAssignableFrom(r) || Enum.class.isAssignableFrom(r));
        });
        List<Method> listGetters = HostMemberResolver.INSTANCE.matchByType(state, m ->
                m.getParameterCount() == 0 && java.util.Collection.class.isAssignableFrom(m.getReturnType()));
        List<Method> intGetters = HostMemberResolver.INSTANCE.matchByType(state, m ->
                m.getParameterCount() == 0
                        && (m.getReturnType() == Integer.TYPE || m.getReturnType() == Integer.class));

        Map<String, Method> resolved = new LinkedHashMap<>();
        int nextList = 0, nextInt = 0;
        for (String prop : stateProps) {
            if (prop.equals("mode")) {
                if (!modeGetters.isEmpty()) resolved.put(prop, modeGetters.get(0));
            } else if (prop.endsWith("Queue")) {
                if (nextList < listGetters.size()) resolved.put(prop, listGetters.get(nextList++));
            } else if (prop.endsWith("Index")) {
                if (nextInt < intGetters.size()) resolved.put(prop, intGetters.get(nextInt++));
            }
        }
        System.out.println();
        System.out.println("resolved accessors:");
        for (Map.Entry<String, Method> e : resolved.entrySet()) {
            System.out.println("   " + e.getKey() + " -> " + clean(e.getValue().getName())
                    + "() : " + e.getValue().getReturnType().getSimpleName());
        }
        check("all five queue accessors resolved",
                resolved.size() >= 5 && resolved.containsKey("mode")
                        && resolved.containsKey("normalQueue") && resolved.containsKey("normalIndex")
                        && resolved.containsKey("randomQueue") && resolved.containsKey("randomIndex"),
                "resolved=" + resolved.keySet());

        // ---- 3. normal != random (the silent-swap guard) ----
        Method nq = resolved.get("normalQueue"), rq = resolved.get("randomQueue");
        Method ni = resolved.get("normalIndex"), ri = resolved.get("randomIndex");
        check("normalQueue and randomQueue are different members",
                nq != null && rq != null && !nq.equals(rq), nq + " vs " + rq);
        check("normalIndex and randomIndex are different members",
                ni != null && ri != null && !ni.equals(ri), ni + " vs " + ri);
        check("queue getters return a collection, index getters return int",
                nq != null && java.util.Collection.class.isAssignableFrom(nq.getReturnType())
                        && ni != null && ni.getReturnType() == Integer.TYPE,
                (nq == null ? "?" : nq.getReturnType().getSimpleName()) + " / "
                        + (ni == null ? "?" : ni.getReturnType().getSimpleName()));

        // ---- 4. pinned ids vs metadata, cross-check ----
        System.out.println();
        System.out.println("=== cross-check: pinned ids vs metadata resolution ===");
        boolean pinnedMatchesMetadata;
        String pinnedReport;
        try {
            Method pinnedMode = findByName(state, "\u037F");
            Method pinnedNq = findByName(state, "\u0528");
            Method pinnedNi = findByName(state, "\u0529");
            Method pinnedRq = findByName(state, "\u052A");
            Method pinnedRi = findByName(state, "\u052B");
            pinnedMatchesMetadata = pinnedMode != null && pinnedNq != null && pinnedNi != null
                    && pinnedRq != null && pinnedRi != null
                    && pinnedNq.equals(nq) && pinnedRq.equals(rq)
                    && pinnedNi.equals(ni) && pinnedRi.equals(ri);
            pinnedReport = "pinned U+037F/U+0528/U+0529/U+052A/U+052B "
                    + (pinnedMatchesMetadata ? "resolve to the SAME members as metadata"
                            : "DIFFER from metadata (metadata path is authoritative; pinned fallback is stale)");
        } catch (Throwable t) {
            pinnedMatchesMetadata = false;
            pinnedReport = "pinned ids failed: " + t;
        }
        System.out.println("   " + pinnedReport);
        check("pinned ids agree with metadata resolution on this build", pinnedMatchesMetadata, pinnedReport);

        // ---- 5. queue element ----
        System.out.println();
        System.out.println("=== queue element (class-file name is R8 output) ===");
        System.out.println("   class: " + clean(item.getSimpleName()));
        List<String> itemProps = HostMemberResolver.INSTANCE.metadataPropertyOrder(item);
        System.out.println("   metadata property order: " + itemProps);
        check("queue element metadata declares id then data",
                itemProps != null && itemProps.size() >= 2
                        && itemProps.get(0).equals("id") && itemProps.get(1).equals("data"),
                String.valueOf(itemProps));

        List<Method> itemInts = HostMemberResolver.INSTANCE.matchByType(item, m ->
                m.getParameterCount() == 0 && m.getReturnType() == Integer.TYPE);
        List<Method> itemRefs = HostMemberResolver.INSTANCE.matchByType(item, m ->
                m.getParameterCount() == 0 && !m.getReturnType().isPrimitive()
                        && m.getReturnType() != item && m.getReturnType() != Void.TYPE);
        check("element id getter (int) and data getter (reference) both found",
                !itemInts.isEmpty() && !itemRefs.isEmpty(), itemInts + " / " + itemRefs);
        if (!itemInts.isEmpty() && !itemRefs.isEmpty()) {
            System.out.println("   id   -> " + clean(itemInts.get(0).getName()) + "() : "
                    + itemInts.get(0).getReturnType().getSimpleName());
            System.out.println("   data -> " + clean(itemRefs.get(0).getName()) + "() : "
                    + itemRefs.get(0).getReturnType().getSimpleName());
        }

        // ---- 6. negative: source getter names do not exist on an obfuscated build ----
        System.out.println();
        System.out.println("=== negative: name-pinned lookup after a rename ===");
        Method missing = findByName(state, "getNormalQueue");
        check("a source getter name is NOT callable on the obfuscated class", missing == null,
                missing == null ? "getNormalQueue() absent, as expected"
                        : "unexpectedly present: " + missing);
        check("metadata path still resolves normalQueue anyway", resolved.get("normalQueue") != null,
                "normalQueue -> " + clean(String.valueOf(resolved.get("normalQueue"))));

        System.out.println();
        System.out.println(pass + "/" + (pass + fail) + " passed");
        System.exit(fail == 0 ? 0 : 1);
    }

    /**
     * Finds the queue element class WITHOUT a pinned name.
     *
     * The metadata reference `Lcom/xuncorp/spc/core/queue/PlaybackQueueItem;` is the *source* name and
     * usually does NOT exist in the class file (R8 renamed the class to a single character), so
     * `Class.forName("…PlaybackQueueItem")` throws. Instead:
     *   1. probe the obfuscated single-character ids in the package (a small, bounded candidate set), and
     *   2. accept the one whose metadata declares the `id` + `data` property pair.
     *
     * That is the same shape test `FoliaPlaybackControls.resolveQueueItemClass` relies on, so a failure
     * here means the element genuinely changed shape and the plugin's lookup would need review.
     */
    static Class<?> findQueueItem(Class<?> state, ClassLoader loader, String pkg) throws Exception {
        java.util.List<String> candidates = new java.util.ArrayList<>();
        // The source name first: some builds leave non-obfuscated members alone.
        candidates.add(pkg + "PlaybackQueueItem");
        // Then the obfuscated single-character ids R8 uses for top-level classes in this package.
        for (char c = 0x0370; c <= 0x03FF; c++) candidates.add(pkg + c);

        Class<?> shape = null;
        for (String candidate : candidates) {
            Class<?> c;
            try {
                c = Class.forName(candidate, false, loader);
            } catch (Throwable ignored) {
                continue;
            }
            if (c.isInterface() || c.isEnum() || c == state) continue;
            java.util.List<String> props = HostMemberResolver.INSTANCE.metadataPropertyOrder(c);
            if (props != null && props.size() >= 2 && props.get(0).equals("id") && props.get(1).equals("data")) {
                return c; // exact match: the element's metadata
            }
            if (shape == null) {
                // Fallback shape: one int getter and one reference getter, two instance fields.
                long ints = HostMemberResolver.INSTANCE.matchByType(c, m ->
                        m.getParameterCount() == 0 && m.getReturnType() == Integer.TYPE).size();
                long refs = HostMemberResolver.INSTANCE.matchByType(c, m ->
                        m.getParameterCount() == 0 && !m.getReturnType().isPrimitive()
                                && m.getReturnType() != c && m.getReturnType() != Void.TYPE).size();
                if (ints == 1 && refs >= 1
                        && HostMemberResolver.INSTANCE.declaredFields(c).size() == 2) {
                    shape = c;
                }
            }
        }
        if (shape != null) return shape;
        throw new IllegalStateException("could not locate the queue element in " + pkg
                + " (checked " + candidates.size() + " candidates; state metadata = "
                + HostMemberResolver.INSTANCE.metadataStrings(state) + ")");
    }

    static Method findByName(Class<?> type, String name) {
        for (Method m : type.getDeclaredMethods()) {
            if (m.getName().equals(name) && m.getParameterCount() == 0) return m;
        }
        return null;
    }
}
