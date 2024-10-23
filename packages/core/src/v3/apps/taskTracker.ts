export type Task = {
  id: string;
  cpu: number;
  memory: number;
};

export class TaskTracker {
  private tasks = new Map<string, Task>();

  public async addTask(task: Task) {
    this.tasks.set(task.id, task);
  }

  public async getTask(id: string) {
    return this.tasks.get(id);
  }

  public async deleteTask(id: string) {
    this.tasks.delete(id);
  }

  public async listTasks() {
    return Array.from(this.tasks.values());
  }

  public getResourceUsage() {
    let cpu = 0;
    let memory = 0;

    for (const task of this.tasks.values()) {
      cpu += task.cpu;
      memory += task.memory;
    }

    return { cpu, memory };
  }

  get totalTasks() {
    return this.tasks.size;
  }
}
