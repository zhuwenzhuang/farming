'use strict';

import type { AgentStartOutcome } from './agent-manager-provider-types.js';

interface MainAgentIdentityChange {
  changed: boolean;
  currentId: string | null;
  previousId: string | null;
}

interface JoinedMainAgentStart {
  owner: false;
  promise: Promise<AgentStartOutcome>;
}

interface OwnedMainAgentStart {
  complete(outcome: AgentStartOutcome): void;
  owner: true;
  promise: Promise<AgentStartOutcome>;
}

type MainAgentStartAdmission = JoinedMainAgentStart | OwnedMainAgentStart;

interface MainAgentStartReservation {
  promise: Promise<AgentStartOutcome>;
  resolve(outcome: AgentStartOutcome): void;
}

class MainAgentIdentityOwner {
  private agentId: string | null = null;
  private startReservation: MainAgentStartReservation | null = null;

  currentId(): string | null {
    return this.agentId;
  }

  hasCurrent(): boolean {
    return this.agentId !== null;
  }

  isCurrent(agentId: string): boolean {
    return this.agentId === agentId;
  }

  setCurrent(agentId: string | null): MainAgentIdentityChange {
    const previousId = this.agentId;
    this.agentId = agentId;
    return {
      changed: previousId !== agentId,
      currentId: agentId,
      previousId,
    };
  }

  clearIf(agentId: string): MainAgentIdentityChange {
    if (!this.isCurrent(agentId)) {
      return {
        changed: false,
        currentId: this.agentId,
        previousId: this.agentId,
      };
    }
    return this.setCurrent(null);
  }

  beginStart(): MainAgentStartAdmission {
    const activeReservation = this.startReservation;
    if (activeReservation) {
      return {
        owner: false,
        promise: activeReservation.promise,
      };
    }

    let resolveReservation: (outcome: AgentStartOutcome) => void = () => {};
    const reservation: MainAgentStartReservation = {
      promise: new Promise<AgentStartOutcome>(resolve => {
        resolveReservation = resolve;
      }),
      resolve: outcome => resolveReservation(outcome),
    };
    this.startReservation = reservation;

    let completed = false;
    return {
      complete: outcome => {
        if (completed) return;
        completed = true;
        if (this.startReservation === reservation) this.startReservation = null;
        reservation.resolve(outcome);
      },
      owner: true,
      promise: reservation.promise,
    };
  }
}

export {
  MainAgentIdentityOwner,
  type MainAgentIdentityChange,
  type MainAgentStartAdmission,
};
