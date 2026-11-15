// The right-click menu of a sidebar widget (the same file in herdr-todos and herdr-memories, each
// installed under its own name: todos-menu, memories-menu). Opened as a popup by the widget with
// props { owner: "<widget>", title?, items: [{ label, icon, action, args, sep?, danger? }] }.
// Choosing an item closes the menu and hands { action, args } back to its owner: shared
// "<owner>.menu", then the "<owner>.menu" command, which the owner reads in nextCommand().
// ↑/↓ move, Enter chooses, Esc closes.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, theme, run, setShared } from "herdr";

export default class WidgetMenu extends View {
  init(_props, cx) {
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  items() {
    return (props()?.items ?? []).filter((it) => it && it.label && it.action);
  }

  choose(i) {
    const p = props() ?? {};
    const it = this.items()[i];
    if (!it) return;
    closeOverlay(p.overlay);
    if (!p.owner) return;
    setShared(`${p.owner}.menu`, { action: it.action, args: it.args ?? {}, at: Date.now() });
    run(`${p.owner}.menu`);
  }

  render(cx) {
    const t = theme();
    const p = props() ?? {};
    const list = this.items();
    return v_flex()
      .id("widget-menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e, cx) => {
        if (!list.length) return;
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at);
        else if (e.key === "escape") closeOverlay(p.overlay);
        else return;
        cx.notify();
      })
      .when(Boolean(p.title), (el) => el.child(div().px(8).pt(4).pb(5).truncate().text_size(11).text_color(t.dim).child(p.title)))
      .children(
        list.map((it, i) =>
          v_flex()
            .when(i > 0 && Boolean(it.sep), (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
            .child(
              h_flex()
                .id(`tm-${i}`)
                .h(31)
                .px(8)
                .gap(9)
                .rounded(7)
                .items_center()
                .cursor_pointer()
                .text_color(it.danger ? t.blocked : t.foreground)
                .when(i === this.at, (el) => el.bg(t.selected))
                .hover((s) => s.bg(t.hover))
                .on_click(() => this.choose(i))
                .child(it.icon ? svg(it.icon).size(14).flex_none().text_color(it.danger ? t.blocked : t.muted) : div().w(14).flex_none())
                .child(div().flex_1().min_w(0).truncate().child(it.label)),
            ),
        ),
      );
  }
}
