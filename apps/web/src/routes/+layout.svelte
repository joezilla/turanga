<script lang="ts">
  // Self-hosted fonts (local-first, no CDN) — CSS side-effect imports.
  import "@fontsource/instrument-sans/400.css";
  import "@fontsource/instrument-sans/500.css";
  import "@fontsource/instrument-sans/600.css";
  import "@fontsource/ibm-plex-mono/400.css";
  import "@fontsource/ibm-plex-mono/500.css";
  import "@fontsource/ibm-plex-mono/600.css";

  // Warm Ink tokens — imported explicitly (colors → typography → spacing → shape → motion)
  // to avoid Vite CSS @import-ordering surprises.
  import "$lib/design/warm-ink/colors.css";
  import "$lib/design/warm-ink/typography.css";
  import "$lib/design/warm-ink/spacing.css";
  import "$lib/design/warm-ink/shape.css";
  import "$lib/design/warm-ink/motion.css";

  // Base layer last (consumes the tokens above).
  import "../app.css";

  let { children } = $props();
</script>

{@render children()}
