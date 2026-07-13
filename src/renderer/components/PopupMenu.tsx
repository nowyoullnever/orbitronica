import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from "react";
import {
  clampPopupPosition,
  navigateMenuIndex,
  type PopupNavigationKey,
  type PopupPosition
} from "./popupMenuModel";

export {
  clampPopupPosition,
  navigateMenuIndex,
  type PopupNavigationKey,
  type PopupPosition,
  type PopupSize
} from "./popupMenuModel";

export type PopupMenuCloseReason =
  | "selection"
  | "escape"
  | "outside-pointer"
  | "resize"
  | "scroll"
  | "owner-change"
  | "focus-leave";

type SelectionInput = "keyboard" | "pointer";

type PopupMenuProps = {
  position: PopupPosition;
  onClose: (reason: PopupMenuCloseReason) => void;
  ariaLabel: string;
  children?: ReactNode;
  anchor?: HTMLElement | null;
  className?: string;
  id?: string;
  propagateEscape?: boolean;
  ownerKey?: string | number;
};

type PopupMenuContextValue = {
  select: (input: SelectionInput) => void;
};

const PopupMenuContext = createContext<PopupMenuContextValue | null>(null);

function enabledMenuItems(menu: HTMLElement) {
  return Array.from(menu.querySelectorAll<HTMLElement>(
    '[role="menuitem"]:not(:disabled):not([aria-disabled="true"])'
  ));
}

export function PopupMenu({
  position,
  onClose,
  ariaLabel,
  children,
  anchor = null,
  className,
  id,
  propagateEscape = false,
  ownerKey
}: PopupMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const closeRequestedRef = useRef(false);
  const previousOwnerKeyRef = useRef(ownerKey);
  const [clampedPosition, setClampedPosition] = useState(position);

  const requestClose = useCallback((reason: PopupMenuCloseReason, input?: SelectionInput) => {
    if (closeRequestedRef.current) return;
    closeRequestedRef.current = true;

    const shouldRestoreFocus = anchor?.isConnected && (
      reason === "escape" || (reason === "selection" && input === "keyboard")
    );
    onClose(reason);
    if (shouldRestoreFocus) queueMicrotask(() => anchor.focus());
  }, [anchor, onClose]);

  useLayoutEffect(() => {
    if (Object.is(previousOwnerKeyRef.current, ownerKey)) return;
    previousOwnerKeyRef.current = ownerKey;
    requestClose("owner-change");
  }, [ownerKey, requestClose]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    const nextPosition = clampPopupPosition(
      position,
      { width: bounds.width, height: bounds.height },
      { width: window.innerWidth, height: window.innerHeight }
    );
    setClampedPosition((current) => current.x === nextPosition.x && current.y === nextPosition.y
      ? current
      : nextPosition);
    const firstItem = enabledMenuItems(menu)[0];
    (firstItem ?? menu).focus();
  }, [position.x, position.y]);

  useLayoutEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || anchor?.contains(target)) return;
      requestClose("outside-pointer", "pointer");
    };
    const onResize = () => requestClose("resize");
    const onScroll = () => requestClose("scroll");

    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [anchor, requestClose]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      requestClose("escape", "keyboard");
      if (!propagateEscape) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      const menu = menuRef.current;
      if (!menu) return;
      const items = enabledMenuItems(menu);
      const currentIndex = items.indexOf(document.activeElement as HTMLElement);
      const nextIndex = navigateMenuIndex(currentIndex, items.length, event.key as PopupNavigationKey);
      if (nextIndex >= 0) items[nextIndex]?.focus();
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.stopPropagation();
      return;
    }

    if (
      event.key === "Delete" ||
      event.key === "Backspace" ||
      (!event.altKey && !event.ctrlKey && !event.metaKey && event.key.length === 1)
    ) {
      event.stopPropagation();
    }
    if (event.key === "Tab") {
      return;
    }
  };

  return <PopupMenuContext.Provider value={{ select: (input) => requestClose("selection", input) }}>
    <div
      ref={menuRef}
      id={id}
      className={["popup-menu", className].filter(Boolean).join(" ")}
      role="menu"
      tabIndex={-1}
      aria-label={ariaLabel}
      style={{ left: clampedPosition.x, top: clampedPosition.y }}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) requestClose("focus-leave");
      }}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  </PopupMenuContext.Provider>;
}

export function PopupMenuItem({
  onClick,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  const popupMenu = useContext(PopupMenuContext);
  const handleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (props.disabled || props["aria-disabled"] === true || props["aria-disabled"] === "true") return;
    popupMenu?.select(event.detail === 0 ? "keyboard" : "pointer");
    onClick?.(event);
  };
  return <button {...props} type={type} role="menuitem" onClick={handleClick} />;
}
