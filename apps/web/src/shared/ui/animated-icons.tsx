import { useImperativeHandle, useLayoutEffect, useRef, type ReactNode, type SVGProps } from "react";

// Geometry and gestures adapted from Hugeicons Animated and Lucide Animated,
// via Pace (PiGUI) apps/desktop/src/shared/ui/animated-icons.tsx.
// See docs/licenses/animated-icons.md for the upstream notices.
export type AnimatedIconProps = Omit<SVGProps<SVGSVGElement>, "children"> & {
  size?: number;
  isAnimated?: boolean;
};

function animatedIcon(name: string, drawing: ReactNode) {
  return function AnimatedIcon({
    size = 24,
    isAnimated = true,
    className,
    ref,
    ...rest
  }: AnimatedIconProps) {
    const svgRef = useRef<SVGSVGElement>(null);
    useImperativeHandle(ref, () => svgRef.current!, []);

    useLayoutEffect(() => {
      const svg = svgRef.current;
      const control = svg?.closest<HTMLElement>("button, a, [role='menuitem']");
      if (!isAnimated || !svg || !control) return;

      // Navigation can mount a fresh icon under a stationary pointer.
      // Only a new pointer visit may start its gesture.
      let visited = control.matches(":hover");
      const enter = (pointer: PointerEvent) => {
        // Chromium transfers hover from the removed control before any move.
        if (pointer.relatedTarget instanceof Node && !pointer.relatedTarget.isConnected) {
          visited = true;
        }
      };
      const move = (pointer: PointerEvent) => {
        if (visited || pointer.pointerType !== "mouse" || pointer.buttons !== 0
          || control.matches(":disabled, [aria-disabled='true']")) return;
        visited = true;
        svg.setAttribute("data-icon-hover", "");
      };
      const leave = () => {
        visited = false;
        svg.removeAttribute("data-icon-hover");
      };
      control.addEventListener("pointerenter", enter);
      control.addEventListener("pointermove", move);
      control.addEventListener("pointerleave", leave);
      return () => {
        control.removeEventListener("pointerenter", enter);
        control.removeEventListener("pointermove", move);
        control.removeEventListener("pointerleave", leave);
        svg.removeAttribute("data-icon-hover");
      };
    }, [isAnimated]);

    return (
      <svg
        ref={svgRef}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className={`pigui-animated-icon ${className ?? ""}`.trim()}
        data-icon-motion={isAnimated ? name : undefined}
        {...rest}
      >
        {drawing}
      </svg>
    );
  };
}

export const AnimatedNewChat = animatedIcon("new-chat", (
  <>
    <g data-icon-part="bubble">
      <path d="M12.5 3.00372C11.6049 2.99039 10.7047 3.01289 9.8294 3.07107C5.64639 3.34913 2.31441 6.72838 2.04024 10.9707C1.98659 11.8009 1.98659 12.6607 2.04024 13.4909C2.1401 15.036 2.82343 16.4666 3.62791 17.6746C4.09501 18.5203 3.78674 19.5758 3.30021 20.4978C2.94941 21.1626 2.77401 21.495 2.91484 21.7351C3.05568 21.9752 3.37026 21.9829 3.99943 21.9982C5.24367 22.0285 6.08268 21.6757 6.74868 21.1846C7.1264 20.9061 7.31527 20.7668 7.44544 20.7508C7.5756 20.7348 7.83177 20.8403 8.34401 21.0513C8.8044 21.2409 9.33896 21.3579 9.8294 21.3905C11.2536 21.4852 12.7435 21.4854 14.1706 21.3905C18.3536 21.1125 21.6856 17.7332 21.9598 13.4909C22.0021 12.836 22.011 12.1627 21.9866 11.5" />
      <path d="M8.5 15H15.5M8.5 10H12" />
    </g>
    <path data-icon-part="add" d="M15 5.5H22M18.5 2L18.5 9" />
  </>
));

const sidebarDrawing = (
  <>
    <path d="M13 3H11C7.22876 3 5.34315 3 4.17157 4.17157C3 5.34315 3 7.22876 3 11V13C3 16.7712 3 18.6569 4.17157 19.8284C5.34315 21 7.22876 21 11 21H13C16.7712 21 18.6569 21 19.8284 19.8284C21 18.6569 21 16.7712 21 13V11C21 7.22876 21 5.34315 19.8284 4.17157C18.6569 3 16.7712 3 13 3Z" />
    <path data-icon-part="divider" d="M9 3V21" />
  </>
);

export const AnimatedSidebar = animatedIcon("sidebar", sidebarDrawing);

export const AnimatedSidebarRight = animatedIcon("sidebar", (
  <g transform="translate(24 0) scale(-1 1)">{sidebarDrawing}</g>
));
