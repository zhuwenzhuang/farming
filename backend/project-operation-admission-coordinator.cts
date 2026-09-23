'use strict';

type ProjectRequestAdmission<Result> = {
  key: string;
  promise: Promise<Result>;
};

type ProjectExclusiveAdmission<Result> = {
  operationKey: string;
  promise: Promise<Result>;
  requestId: string;
  purpose: string;
};

class ProjectOperationAdmissionCoordinator {
  private readonly requests = new Map<string, ProjectRequestAdmission<unknown>>();
  private readonly exclusive = new Map<string, ProjectExclusiveAdmission<unknown>>();

  runRequest<Result>(
    requestId: string,
    key: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    if (!requestId) return operation();
    const current = this.requests.get(requestId) as ProjectRequestAdmission<Result> | undefined;
    if (current) {
      if (current.key === key) return current.promise;
      return Promise.reject(
        new Error(`Project operation request ${requestId} was already used for different parameters`),
      );
    }
    const promise = operation();
    const admission: ProjectRequestAdmission<Result> = { key, promise };
    this.requests.set(requestId, admission);
    void promise.finally(() => {
      if (this.requests.get(requestId) === admission) this.requests.delete(requestId);
    }).catch(() => {});
    return promise;
  }

  runExclusive<Result>(
    key: string,
    requestId: string,
    operation: () => Promise<Result>,
    matches: (left: string, right: string) => boolean = (left, right) => left === right,
    operationKey: string = requestId,
    purpose = '',
  ): Promise<Result> {
    if (!key) return operation();
    const currentEntry = [...this.exclusive.entries()]
      .find(([currentKey]) => matches(currentKey, key));
    const current = currentEntry?.[1] as ProjectExclusiveAdmission<Result> | undefined;
    if (current) {
      if (requestId && current.requestId === requestId) {
        if (current.operationKey === operationKey) return current.promise;
        return Promise.reject(
          new Error(`Project operation request ${requestId} was already used for different parameters`),
        );
      }
      return current.promise
        .catch(() => {})
        .then(() => this.runExclusive(key, requestId, operation, matches, operationKey, purpose));
    }
    const promise = operation();
    const admission: ProjectExclusiveAdmission<Result> = { operationKey, requestId, promise, purpose };
    this.exclusive.set(key, admission);
    void promise.finally(() => {
      if (this.exclusive.get(key) === admission) this.exclusive.delete(key);
    }).catch(() => {});
    return promise;
  }

  findExclusiveKey(
    candidate: string,
    matches: (exclusiveKey: string, candidate: string) => boolean,
    purpose = '',
  ): string {
    if (!candidate) return '';
    return [...this.exclusive.entries()]
      .find(([key, admission]) => matches(key, candidate) && (!purpose || admission.purpose === purpose))?.[0] || '';
  }

  pendingOperations(): Promise<unknown>[] {
    return [...new Set([
      ...[...this.requests.values()].map(admission => admission.promise),
      ...[...this.exclusive.values()].map(admission => admission.promise),
    ])];
  }

  clear(): void {
    this.requests.clear();
    this.exclusive.clear();
  }
}

export { ProjectOperationAdmissionCoordinator };
