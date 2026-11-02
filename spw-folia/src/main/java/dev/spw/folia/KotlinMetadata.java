package dev.spw.folia;

import java.lang.annotation.Annotation;

/**
 * The one piece of Kotlin-metadata reading that has to live in Java.
 *
 * **Do not port this file to Kotlin.** Two hard language limits make it impossible there without
 * adding a kotlin-stdlib-metadata / kotlin-reflect dependency (which this plugin deliberately avoids,
 * because the host ships its own Kotlin runtime and the versions drift):
 *
 *  1. Kotlin maps `Class.getDeclaredAnnotations()` to `Array<kotlin.Annotation>`, and that Kotlin type
 *     has no `annotationType()` — the annotation cannot even be identified. From Java the same call
 *     yields `java.lang.annotation.Annotation[]`, where `annotationType()` is available.
 *  2. The annotation *instance* is created by the host's classloader. Comparing `Class` objects across
 *     loaders always fails, so the annotation type must be matched by NAME (`kotlin.Metadata`) — which
 *     is what this file does, and why it works regardless of which loader defined the class.
 *
 * See the note next to the `java {}` block in `spw-folia/build.gradle.kts` and
 * `docs/upstream-sync.md` §11 (SPW 宿主升级时的反混淆检查).
 *
 * Why a Java file
 * ---------------
 * {@link HostMemberResolver} needs the `d2` string table of Kotlin `@Metadata` to recover source-level
 * property names from an R8-obfuscated host. That table is what makes name-free resolution possible
 * for the playback queue model — see the Steam workshop post by Salt Player's official developer on
 * why pinned obfuscated names break on every player update.
 *
 * {@link HostMemberResolver#metadataStrings} is the only caller; if the host was built without Kotlin
 * metadata (or strips it), metadataD2 returns null and every resolution path falls back to
 * structural/legacy lookups.
 */
public final class KotlinMetadata {

    private KotlinMetadata() {
    }

    private static final String METADATA_ANNOTATION = "kotlin.Metadata";

    /**
     * The `d2` string table of the class's Kotlin `@Metadata` annotation.
     *
     * `d2` holds the metadata string table: source-level property names (`normalQueue`), generated
     * getter names (`getNormalQueue`), signatures, and — importantly for R8 output — references to the
     * *original* type names of classes the obfuscator renamed.
     *
     * @return the table, or null when the class carries no Kotlin metadata
     */
    public static String[] metadataD2(Class<?> type) {
        if (type == null) return null;
        Annotation[] annotations;
        try {
            annotations = type.getDeclaredAnnotations();
        } catch (Throwable ignored) {
            return null;
        }
        for (Annotation annotation : annotations) {
            String name;
            try {
                name = annotation.annotationType().getName();
            } catch (Throwable ignored) {
                continue;
            }
            if (!METADATA_ANNOTATION.equals(name)) continue;
            try {
                java.lang.reflect.Method d2 = annotation.annotationType().getMethod("d2");
                Object value = d2.invoke(annotation);
                if (value instanceof String[]) return (String[]) value;
                return null;
            } catch (Throwable ignored) {
                return null;
            }
        }
        return null;
    }
}
