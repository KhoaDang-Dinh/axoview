---
title: Connectors
description: Connecting items, rerouting, waypoints, connector names, labels and styles, deleting
audience: public
---

# Connectors

## Connecting two items

<!-- keywords: arrow, line, link, join, draw a connection, relationship, edge -->

Press **C** or click **Connector** in the tool menu. Then, in the default click
mode, click the first item (or a point on the canvas) and then the second item.
In drag mode, drag from the first item to the second. **Esc** cancels.

Choose the mode in Settings → **Connector Settings** → **Connection Creation
Mode**: **Click Mode (Recommended)** or **Drag Mode**. The tool menu also shows
**Click** / **Drag** while the connector tool is active.

## Rerouting a connector

<!-- keywords: bend, waypoint, route, path, anchor, curve -->

Select the connector, then click a point on its line and drag: this adds a
waypoint or moves an existing one. **Alt + click** a waypoint removes it (the
connector does not need to be selected); the two ends stay attached.

## Attaching a loose end

If a connector end is not attached to an item, drag that end onto the item you
want it connected to.

## Naming a connector and adding labels

<!-- keywords: label on a connection, edge label, text on a line, protocol -->

Double-click a connector (or **Details…**) to open its panel:

- **Name** is the connector's main text (for example "HTTPS" or "writes to").
- **Labels** → **Add label** adds extra text along the line. Drag a label on
  the canvas to move it along the connector; use the top bar for its text size
  and colour. On double lines, choose **Line 1** or **Line 2**.
- **Notes** holds longer text that is not drawn.

## Connector colour and line style

<!-- keywords: dashed, dotted, colour, color, thickness, double line, arrowhead -->

Select a connector and use the top bar:

- **Connection color** sets its colour.
- **Line options** → **Line style** (solid, dotted, dashed), **Line type**
  (single, double, double with circle), **Width** and **Show arrow**.

With the connector tool active and nothing selected, the same controls set the
colour and line style of the next connector you draw.

## Deleting a connector

<!-- keywords: remove connection, delete line, disconnect, unlink -->

Click the connector's line to select it, then press **Delete** (Backspace on
Mac) or choose **Delete** in its context menu. The items it joined stay where
they are. **Ctrl+Z** brings the connector back.
