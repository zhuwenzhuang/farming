'use strict';

type ProjectRequestAdmission<Result> = {
  key: string;
  promise: Promise<Result>;
};

type ProjectExclusiveAdmission<Result> = {
  promise: Promise<Result>;
  requestId: string;
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
  ): Promise<Result> {
    if (!key) return operation();
    const current = this.exclusive.get(key) as ProjectExclusiveAdmission<Result> | undefined;
    if (current) {
      if (requestId && current.requestId === requestId) return current.promise;
      return current.promise
        .catch(() => {})
        .then(() => this.runExclusive(key, requestId, operation));
    }
    const promise = operation();
    const admission: ProjectExclusiveAdmission<Result> = { requestId, promise };
    this.exclusive.set(key, admission);
    void promise.finally(() => {
      if (this.exclusive.get(key) === admission) this.exclusive.delete(key);
    }).catch(() => {});
    return promise;
  }

  findExclusiveKey(
    candidate: string,
    matches: (exclusiveKey: string, candidate: string) => boolean,
  ): string {
    if (!candidate) return '';
    return [...this.exclusive.keys()].find(key => matches(key, candidate)) || '';
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
