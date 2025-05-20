import { createApp } from 'vue';
import type { App } from 'vue';
import MkImageLightbox from './MkImageLightbox.vue';

let app: App<Element> | null = null;
let container: HTMLDivElement | null = null;

type LightboxOptions = {
  src: string;
  alt?: string;
};

export function openImageLightbox(options: LightboxOptions) {
  if (app) return; // すでに開いている場合は何もしない

  container = document.createElement('div');
  document.body.appendChild(container);

  app = createApp(MkImageLightbox, {
    ...options,
    onClose: () => {
      closeImageLightbox();
    }
  });

  app.mount(container);
}

export function closeImageLightbox() {
  if (app && container) {
    app.unmount();
    document.body.removeChild(container);
    app = null;
    container = null;
  }
}
