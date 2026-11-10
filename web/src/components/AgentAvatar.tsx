import { agentHue, isAvatarImage } from "../agents";
import { initials } from "../lib/initials";
import { cn } from "../lib/cn";
import type { Agent } from "../types";

interface Props {
  agent: Pick<Agent, "id" | "name" | "avatar">;
  /** Side in pixels: the board shows a small one, the agent card a large one. */
  size?: number;
  className?: string;
  title?: string;
}

/** The agent's face: an uploaded picture, a glyph or, by default, initials on the agent's own color. */
export function AgentAvatar({ agent, size = 24, className, title }: Props) {
  const style = { width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.42)) };
  if (isAvatarImage(agent.avatar)) {
    return (
      <img
        src={agent.avatar}
        alt=""
        title={title ?? agent.name}
        style={style}
        className={cn("shrink-0 rounded-full object-cover", className)}
      />
    );
  }
  return (
    <span
      aria-hidden
      title={title ?? agent.name}
      style={{
        ...style,
        background: `color-mix(in oklab, hsl(${agentHue(agent.id)} 65% 50%) 22%, var(--surface))`,
        color: `color-mix(in oklab, hsl(${agentHue(agent.id)} 70% 45%) 75%, var(--ink))`,
      }}
      className={cn("flex shrink-0 select-none items-center justify-center rounded-full font-semibold leading-none", className)}
    >
      {agent.avatar || initials(agent.name)}
    </span>
  );
}
