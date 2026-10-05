import { randomUUID } from "node:crypto";

export type MessageType = "TASK_ASSIGNED" | "TASK_RESULT" | "STATUS_CHANGED" | "ERROR";

/** Sender/recipient: an agent id, or ORCHESTRATOR. */
export type Address = string;
export const ORCHESTRATOR: Address = "ORCHESTRATOR";

export interface AgentMessage<P = unknown> {
  message_id: string;
  type: MessageType;
  from: Address;
  to: Address;
  task_id?: string;
  payload: P;
  timestamp: string;
}

export function createMessage<P>(
  type: MessageType,
  from: Address,
  to: Address,
  payload: P,
  task_id?: string,
): AgentMessage<P> {
  const msg: AgentMessage<P> = { message_id: randomUUID(), type, from, to, payload, timestamp: new Date().toISOString() };
  if (task_id !== undefined) msg.task_id = task_id;
  return msg;
}

type Listener = (msg: AgentMessage) => void;

/** In-memory, bounded message log with subscribers. A faulty subscriber never breaks publishing. */
export class MessageBus {
  private readonly log: AgentMessage[] = [];
  private readonly listeners = new Set<Listener>();

  constructor(private readonly limit = 10_000) {}

  publish(msg: AgentMessage): void {
    this.log.push(msg);
    if (this.log.length > this.limit) this.log.shift();
    for (const l of this.listeners) {
      try {
        l(msg);
      } catch {
        /* isolate subscriber failures */
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  history(filter?: Partial<Pick<AgentMessage, "type" | "from" | "to" | "task_id">>): readonly AgentMessage[] {
    if (!filter) return [...this.log];
    return this.log.filter((m) => Object.entries(filter).every(([k, v]) => v === undefined || m[k as keyof AgentMessage] === v));
  }

  clear(): void {
    this.log.length = 0;
  }
}
