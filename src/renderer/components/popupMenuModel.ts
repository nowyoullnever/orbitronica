export type PopupPosition = { x: number; y: number };
export type PopupSize = { width: number; height: number };
export type PopupNavigationKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

export function clampPopupPosition(
  position: PopupPosition,
  popupSize: PopupSize,
  viewportSize: PopupSize,
  margin = 8
): PopupPosition {
  const maxX = Math.max(margin, viewportSize.width - popupSize.width - margin);
  const maxY = Math.max(margin, viewportSize.height - popupSize.height - margin);
  return {
    x: Math.min(Math.max(position.x, margin), maxX),
    y: Math.min(Math.max(position.y, margin), maxY)
  };
}

export function navigateMenuIndex(
  currentIndex: number,
  itemCount: number,
  key: PopupNavigationKey
): number {
  if (itemCount <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return itemCount - 1;
  if (key === "ArrowDown") return currentIndex < 0 ? 0 : (currentIndex + 1) % itemCount;
  return currentIndex < 0 ? itemCount - 1 : (currentIndex - 1 + itemCount) % itemCount;
}
