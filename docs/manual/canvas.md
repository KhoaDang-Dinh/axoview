---
title: Working with the canvas
description: Zoom, pan, rotate, 2D and isometric views, selecting, the context menu, undo
audience: public
---

# Working with the canvas

## Zooming

<!-- keywords: zoom in, zoom out, magnify, fit, scale -->

Scroll the mouse wheel to zoom. By default the zoom moves toward the cursor; turn
off **Zoom to Cursor** in Settings → Canvas to zoom around the centre instead.
The zoom controls (bottom right) have **Zoom in**, **Zoom out** and **Fit to
screen**. **Keep labels readable** keeps label text a readable size when you
zoom far out.

## Panning (moving around)

<!-- keywords: move around, scroll, navigate, drag canvas -->

- Hold the right mouse button and drag, or drag with the middle button.
- The arrow keys nudge the canvas.
- The **Pan** tool (hotkey **M**) makes a left-drag pan. A right-click without
  dragging toggles pan mode; a left-click returns to select.

## Rotating the isometric view

<!-- keywords: rotate, turn, angle, orbit, spin -->

- **Q** turns the floor 15° counter-clockwise and **E** 15° clockwise; with
  **Shift** they jump to the next quarter turn.
- **Alt + drag** orbits freely; hold **Shift** while orbiting to snap to 15°.
- The rotation controls show the current angle. **Set as page default** makes
  this page open at that angle for everyone; **Unpin page default** returns it to
  0°. Both are one undo step.

Rotation is only available in the isometric view.

## Switching between 2D and isometric

<!-- keywords: flat, 2d, top-down, isometric, 3d, projection -->

The tool menu has **Switch to 2D view** and **Switch to isometric view**. The
diagram is the same; only the projection changes.

## Selecting items

<!-- keywords: multiple, multi-select, select many, box select, lasso -->

- **Click** an item to select it; click empty canvas to clear the selection.
- **Ctrl/Cmd + click** adds or removes an item from the selection.
- Drag on empty canvas, or use the **Lasso select** tool (**L**), to draw a
  selection box. **Freehand lasso** (**F**) selects everything inside a shape
  you draw.
- **Ctrl+A** selects every visible, unlocked item on the page.
- Once several items are selected, drag inside the selection to move them
  together.
- The **Select** tool (**S**) returns to normal selection.

## The context menu

Right-click without dragging (long-press on touch) to open the context menu: the
item menu over an item, the canvas menu over empty space. It has **Details…**,
**Rename**, **Add/edit note**, **Add label**, **Cut**, **Copy**, **Paste**,
**Duplicate**, stacking order, **Assign to layer**, grid and collision options
and **Delete**.

## Undo and redo

<!-- keywords: undo, redo, mistake, revert, go back -->

**Ctrl+Z** undoes; **Ctrl+Y** or **Ctrl+Shift+Z** redoes (Cmd on Mac). The tool
menu also has **Undo** and **Redo** buttons. Deleting, cutting, pasting and
changing a page's default angle can all be undone.
