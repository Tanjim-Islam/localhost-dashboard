// macOS process context reader. Compiled during the Mac build, never on a user's
// machine. Private stdin/stdout RPC, no shell, no files containing environments.
#import <Foundation/Foundation.h>
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/proc.h>
#include <sys/sysctl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static NSDictionary *identity(pid_t pid) {
  struct proc_bsdinfo info = {0};
  char executable[PROC_PIDPATHINFO_MAXSIZE] = {0};
  if (pid <= 1 || proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != (int)sizeof(info) ||
      info.pbi_uid != getuid() || info.pbi_status == SZOMB ||
      proc_pidpath(pid, executable, sizeof(executable)) <= 0) return nil;
  NSString *file = [[NSString alloc] initWithUTF8String:executable];
  if (!file) return nil;
  return @{ @"pid": @(pid), @"ppid": @(info.pbi_ppid), @"executable": file,
    @"started": [NSString stringWithFormat:@"%llu:%llu", (unsigned long long)info.pbi_start_tvsec, (unsigned long long)info.pbi_start_tvusec],
    @"startedMs": @(info.pbi_start_tvsec * 1000.0 + info.pbi_start_tvusec / 1000.0) };
}

static BOOL same(NSDictionary *a, NSDictionary *b) {
  return a && b && [a[@"pid"] isEqual:b[@"pid"]] && [a[@"started"] isEqual:b[@"started"]] &&
    [a[@"executable"] isEqual:b[@"executable"]];
}

static NSString *readString(char **cursor, char *end) {
  if (*cursor >= end) return nil;
  char *zero = memchr(*cursor, 0, end - *cursor);
  if (!zero) return nil;
  NSString *value = [[NSString alloc] initWithBytes:*cursor length:zero - *cursor encoding:NSUTF8StringEncoding];
  *cursor = zero + 1;
  return value;
}

static NSDictionary *context(pid_t pid) {
  NSDictionary *before = identity(pid);
  if (!before) return nil;
  struct proc_vnodepathinfo vnode = {0};
  if (proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &vnode, sizeof(vnode)) != (int)sizeof(vnode)) return nil;
  NSString *cwd = [[NSString alloc] initWithUTF8String:vnode.pvi_cdir.vip_path];
  int limit = 0; size_t size = sizeof(limit); int argmax[] = {CTL_KERN, KERN_ARGMAX};
  if (!cwd || sysctl(argmax, 2, &limit, &size, NULL, 0) != 0 || limit <= 0 || limit > 2097152) return nil;
  NSMutableData *buffer = [NSMutableData dataWithLength:limit];
  int mib[] = {CTL_KERN, KERN_PROCARGS2, pid}; size = limit;
  if (sysctl(mib, 3, buffer.mutableBytes, &size, NULL, 0) != 0 || size < sizeof(int)) return nil;
  char *base = buffer.mutableBytes, *end = base + size, *cursor = base + sizeof(int);
  int argc = 0; memcpy(&argc, base, sizeof(argc));
  if (argc <= 0 || argc > 4096 || !readString(&cursor, end)) return nil;
  while (cursor < end && *cursor == 0) cursor++;
  NSMutableArray *argv = [NSMutableArray array];
  for (int i = 0; i < argc; i++) {
    NSString *arg = readString(&cursor, end);
    if (!arg) return nil;
    [argv addObject:arg];
  }
  NSMutableDictionary *env = [NSMutableDictionary dictionary];
  // KERN_PROCARGS2 contains NUL-delimited argv followed by envp. Empty argv
  // entries are preserved. Padding after argv is skipped before the environment.
  while (cursor < end && *cursor == 0) cursor++;
  while (cursor < end && *cursor != 0) {
    NSString *entry = readString(&cursor, end);
    if (!entry) return nil;
    NSRange separator = [entry rangeOfString:@"="];
    if (separator.location == NSNotFound || separator.location == 0) return nil;
    env[[entry substringToIndex:separator.location]] = [entry substringFromIndex:separator.location + 1];
  }
  if (!same(before, identity(pid))) return nil;
  NSMutableDictionary *result = [before mutableCopy];
  result[@"argv"] = argv; result[@"cwd"] = cwd; result[@"env"] = env;
  return result;
}

static id handle(NSDictionary *request) {
  NSString *op = request[@"op"];
  if ([op isEqual:@"snapshot"]) {
    int capacity = proc_listpids(PROC_ALL_PIDS, 0, NULL, 0);
    if (capacity <= 0 || capacity > 4 * 1024 * 1024) return nil;
    NSMutableData *pids = [NSMutableData dataWithLength:capacity + 4096];
    int count = proc_listpids(PROC_ALL_PIDS, 0, pids.mutableBytes, (int)pids.length) / sizeof(pid_t);
    NSMutableArray *processes = [NSMutableArray array], *contexts = [NSMutableArray array];
    NSMutableDictionary *byPid = [NSMutableDictionary dictionary];
    for (int i = 0; i < count; i++) {
      NSDictionary *p = identity(((pid_t *)pids.bytes)[i]);
      if (p) { [processes addObject:p]; byPid[p[@"pid"]] = p; }
    }
    NSNumber *next = request[@"pid"];
    for (int depth = 0; depth < 16 && next.intValue > 1; depth++) {
      NSDictionary *p = byPid[next]; if (!p) break;
      NSDictionary *ctx = context(next.intValue); if (ctx) [contexts addObject:ctx];
      next = p[@"ppid"];
    }
    return @{ @"processes": processes, @"contexts": contexts };
  }
  if ([op isEqual:@"interrupt"] || [op isEqual:@"stop"]) {
    NSMutableArray *results = [NSMutableArray array];
    NSArray *targets = request[@"targets"];
    if (![targets isKindOfClass:NSArray.class] || targets.count > 128) return nil;
    for (NSDictionary *target in targets) {
      pid_t pid = [target[@"pid"] intValue];
      BOOL valid = pid != getpid() && same(target, identity(pid));
      [results addObject:@(valid && kill(pid, [op isEqual:@"interrupt"] ? SIGINT : SIGKILL) == 0)];
    }
    return results;
  }
  return nil;
}

int main(void) {
  @autoreleasepool {
    char *line = NULL; size_t capacity = 0; ssize_t length;
    while ((length = getline(&line, &capacity, stdin)) > 0) {
      @autoreleasepool {
        if (length > 65536) break;
        @try {
          NSDictionary *request = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:line length:length] options:0 error:NULL];
          id result = [request isKindOfClass:NSDictionary.class] ? handle(request) : nil;
          NSDictionary *response = result ? @{ @"id": request[@"id"], @"result": result } : @{ @"error": @"Process inspection failed." };
          NSData *json = [NSJSONSerialization dataWithJSONObject:response options:0 error:NULL];
          fwrite(json.bytes, 1, json.length, stdout); fputc('\n', stdout); fflush(stdout);
        } @catch (NSException *exception) {
          fputs("{\"error\":\"Process inspection failed.\"}\n", stdout); fflush(stdout);
        }
      }
    }
    free(line);
  }
  return 0;
}
