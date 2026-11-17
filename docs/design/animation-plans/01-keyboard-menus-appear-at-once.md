# 01 Keyboard-opened menus appear at once

## Why

The slash menu opens because someone typed "/". Emil's rule: never animate an action the keyboard started; it is the most frequent thing a fast editor does, and a 180 ms scale on every "/" reads as lag. The brand switch menu can be opened by mouse or by keyboard, so it should animate only for the mouse.

## Where

`src/renderer/src/cutalong/motion.css`, the block that starts `/* Menus scale and fade in from the edge they open on. */` (about line 124):

```css
.cl-slash,
.cl-menu {
  transition-property: opacity, scale, translate;
  transition-duration: var(--duration-base);
  transition-timing-function: var(--ease-enter);
  transform-origin: 50% 100%;
}
@starting-style {
  .cl-slash,
  .cl-menu { opacity: 0; scale: calc(1 - 0.04 * var(--cl-travel)); translate: 0 calc(var(--space-1) * var(--cl-travel)); }
  ...
}
```

`src/renderer/src/cutalong/components/Composer.tsx` renders `.cl-slash` while the text starts with "/".
`src/renderer/src/cutalong/components/BrandSwitch.tsx` renders `.cl-menu` from a button.

## Change

1. Take `.cl-slash` out of both selectors above, so the slash menu has no transition and no starting style. It appears in the frame the key lands.
2. Keep `.cl-menu`, but only when a pointer opened it. In `BrandSwitch.tsx`, read `event.detail` on the button's click: `0` means keyboard (Enter or Space). Put `data-by-key` on the menu when it is `0`, and add:

```css
.cl-menu[data-by-key] { transition: none; }
```

3. While in `BrandSwitch.tsx`: when the menu opens, move focus to the checked item; Arrow Up and Down move between items; Escape closes it and returns focus to the button; Tab closes it. (This is the P3 focus finding in the main report.)

## Check

- Type "/" in the composer: the menu is there in the same frame. In DevTools, `document.getAnimations()` right after the key press holds nothing for `.cl-slash`.
- Click the brand switch: the menu scales in from its top right corner in 180 ms. Press Enter on the button instead: it appears at once, with focus on the current brand.
- Less motion on: no change from today for either.
