// pinomad-host: what the host service runs on macOS when the Mac App set it
// up (ServiceSpec.launcher in apps/host/src/service/definition.ts).
//
//   pinomad-host <node> <script> [args…]
//
// macOS asks for file access (Documents, Desktop, …) on behalf of the process
// launchd started, and everything that process spawns inherits it. Started
// as node, the host and its terminals ask as "node"; started through this
// helper, signed inside PiNomad.app, they ask as the app. So it spawns node
// as its child and stays the parent. exec would swap the signed image for
// node's and lose that.
//
// launchd signals only this process, so it passes signals on and waits for
// the host's own shutdown, then exits as the host did: KeepAlive restarts a
// host that crashed exactly as before.
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static const int forwarded[] = {SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGUSR1, SIGUSR2};
#define FORWARDED (sizeof forwarded / sizeof forwarded[0])

static volatile sig_atomic_t child = 0;

static void forward(int signal_number) {
  if (child > 0) kill((pid_t)child, signal_number);
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: %s <program> [args...]\n", argv[0]);
    return 64;
  }

  // Held until the handlers are in, so a signal that lands while node starts
  // is passed on rather than killing this process and orphaning node.
  sigset_t held, previous;
  sigemptyset(&held);
  for (size_t i = 0; i < FORWARDED; i++) sigaddset(&held, forwarded[i]);
  sigprocmask(SIG_BLOCK, &held, &previous);

  // node starts with the signal mask and dispositions this process had.
  posix_spawnattr_t attr;
  posix_spawnattr_init(&attr);
  posix_spawnattr_setsigmask(&attr, &previous);
  posix_spawnattr_setsigdefault(&attr, &held);
  posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF);
  pid_t pid;
  int error = posix_spawn(&pid, argv[1], NULL, &attr, argv + 1, environ);
  posix_spawnattr_destroy(&attr);
  if (error != 0) {
    fprintf(stderr, "pinomad-host: can't run %s: %s\n", argv[1], strerror(error));
    return 127;
  }
  child = pid;

  struct sigaction action;
  memset(&action, 0, sizeof action);
  action.sa_handler = forward;
  sigemptyset(&action.sa_mask);
  action.sa_flags = SA_RESTART;
  for (size_t i = 0; i < FORWARDED; i++) sigaction(forwarded[i], &action, NULL);
  sigprocmask(SIG_SETMASK, &previous, NULL);

  int status;
  while (waitpid(pid, &status, 0) < 0) {
    if (errno != EINTR) {
      perror("pinomad-host: waitpid");
      return 1;
    }
  }
  if (WIFEXITED(status)) return WEXITSTATUS(status);

  // Die the same way, so launchd sees what happened to the host.
  int signal_number = WTERMSIG(status);
  signal(signal_number, SIG_DFL);
  sigset_t only;
  sigemptyset(&only);
  sigaddset(&only, signal_number);
  sigprocmask(SIG_UNBLOCK, &only, NULL);
  raise(signal_number);
  return 128 + signal_number;
}
