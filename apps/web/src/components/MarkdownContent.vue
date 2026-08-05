<script setup lang="ts">
import { computed } from "vue";
import DOMPurify from "dompurify";
import { marked } from "marked";

const props = defineProps<{ source: string }>();
const html = computed(() => {
  const rendered = marked.parse(props.source, { async: false, gfm: true, breaks: true }) as string;
  return DOMPurify.sanitize(rendered, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form"],
    FORBID_ATTR: ["style", "onerror", "onclick", "onload"]
  });
});
</script>

<template><div class="markdown-body" v-html="html"></div></template>
