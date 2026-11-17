# Animation plans

Written with the improve-animations method: each plan stands alone, names its files and the code as it is, says what to change and how to check it. They were written against commit `6ffa7e7` (brands per channel). Other builders are changing screens now, so re-read each file before applying a plan; the line numbers will drift.

Apply them in this order. Each is small and safe on its own.

| Plan | What it fixes | Size |
| --- | --- | --- |
| [01 Keyboard-opened menus appear at once](01-keyboard-menus-appear-at-once.md) | The slash menu animates every time "/" is typed | small |
| [02 Exits ease out](02-exits-ease-out.md) | Toasts and notes leave on an ease-in curve, so they hang and then snap | small |
| [03 Staggers that read as one motion](03-staggers-read-as-one.md) | Reply parts, lists and the rail stagger in even steps, which reads as a queue | small |
| [04 Hover only where there is a pointer](04-hover-only-with-a-pointer.md) | Beat blocks lift on hover and 14 hover rules stick on touch | small |
| [05 Less motion, everywhere](05-less-motion-everywhere.md) | Smooth scrolling and the toggle's spring ignore the Less motion setting | small |

What these plans do not cover, because the chosen direction replaces it: the toast's position (it moves to the top right of the window, off the strip), the composer's morph (it is rebuilt as one row), and coral (see the main report).
