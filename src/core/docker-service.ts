import Docker from 'dockerode';
import { CONFIG } from '../config.js';
import { ContainerId } from '../types/state.js';

class DockerService {
  private docker: Docker | null = null;
  private isDockerAvailable = false;

  constructor() {
    this.initDocker();
  }

  private initDocker(): void {
    try {
      if (process.platform === 'win32' && !process.env.DOCKER_HOST) {
        // Windows Named Pipe
        this.docker = new Docker({ socketPath: '//./pipe/docker_engine' });
      } else {
        // Unix socket or DOCKER_HOST
        this.docker = new Docker({ socketPath: CONFIG.DOCKER_SOCKET_PATH });
      }
      this.isDockerAvailable = true;
    } catch (err) {
      console.warn('[DockerService] Failed to initialize Docker client, fallback to simulated docker mode:', err);
      this.isDockerAvailable = false;
    }
  }

  public async ping(): Promise<boolean> {
    if (!this.docker) return false;
    try {
      await this.docker.ping();
      this.isDockerAvailable = true;
      return true;
    } catch {
      this.isDockerAvailable = false;
      return false;
    }
  }

  private getContainerTargetName(id: ContainerId): string {
    return id === 'A' ? CONFIG.APP_A.dockerContainerName : CONFIG.APP_B.dockerContainerName;
  }

  public async isContainerRunning(id: ContainerId): Promise<boolean> {
    if (!this.docker) return false;
    try {
      const containerName = this.getContainerTargetName(id);
      const containers = await this.docker.listContainers({ all: true });
      const found = containers.find((c) =>
        c.Names.some((n) => n === `/${containerName}` || n === containerName || n.includes(containerName))
      );
      return found ? found.State === 'running' : false;
    } catch (err) {
      console.warn(`[DockerService] Could not check container status for ${id}:`, err);
      return false;
    }
  }

  public async startContainer(id: ContainerId): Promise<{ success: boolean; message: string }> {
    const containerName = this.getContainerTargetName(id);
    if (!this.docker) {
      return { success: true, message: `[Simulated] Container ${id} (${containerName}) started.` };
    }

    try {
      const container = this.docker.getContainer(containerName);
      const info = await container.inspect();
      if (info.State.Running) {
        return { success: true, message: `Container ${containerName} is already running.` };
      }

      await container.start();
      return { success: true, message: `Successfully started container ${containerName}.` };
    } catch (err: any) {
      // If container was not found by exact name, search in list
      try {
        const containers = await this.docker.listContainers({ all: true });
        const match = containers.find((c) =>
          c.Names.some((n) => n.includes(containerName) || n === `/${containerName}`)
        );
        if (match) {
          const container = this.docker.getContainer(match.Id);
          if (match.State !== 'running') {
            await container.start();
          }
          return { success: true, message: `Started container ${match.Names[0]}.` };
        }
      } catch {}

      return {
        success: false,
        message: `Failed to start Docker container ${containerName}: ${err.message || err}`,
      };
    }
  }

  public async stopContainer(id: ContainerId): Promise<{ success: boolean; message: string }> {
    const containerName = this.getContainerTargetName(id);
    if (!this.docker) {
      return { success: true, message: `[Simulated] Container ${id} (${containerName}) stopped.` };
    }

    try {
      const container = this.docker.getContainer(containerName);
      const info = await container.inspect();
      if (!info.State.Running) {
        return { success: true, message: `Container ${containerName} is already stopped.` };
      }

      await container.stop({ t: 2 }); // 2-second SIGTERM timeout
      return { success: true, message: `Successfully stopped container ${containerName}.` };
    } catch (err: any) {
      try {
        const containers = await this.docker.listContainers({ all: true });
        const match = containers.find((c) =>
          c.Names.some((n) => n.includes(containerName) || n === `/${containerName}`)
        );
        if (match && match.State === 'running') {
          const container = this.docker.getContainer(match.Id);
          await container.stop({ t: 2 });
          return { success: true, message: `Stopped container ${match.Names[0]}.` };
        }
      } catch {}

      return {
        success: false,
        message: `Failed to stop Docker container ${containerName}: ${err.message || err}`,
      };
    }
  }
}

export const dockerService = new DockerService();
