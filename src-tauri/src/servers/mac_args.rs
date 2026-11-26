// Darwin's argc is authoritative. Skipping repeated NULs between arguments
// would discard empty arguments and can move the first environment entry into argv.
pub(super) struct Arguments<'a> {
    pub argv: Vec<&'a [u8]>,
    pub environment: Vec<(&'a [u8], &'a [u8])>,
}
fn string<'a>(data: &mut &'a [u8]) -> Option<&'a [u8]> {
    let end = data.iter().position(|&byte| byte == 0)?;
    let (value, rest) = data.split_at(end);
    *data = &rest[1..];
    Some(value)
}
fn padding<'a>(data: &mut &'a [u8]) {
    *data = &data[data.iter().position(|&b| b != 0).unwrap_or(data.len())..];
}
pub(super) fn parse(bytes: &[u8]) -> Option<Arguments<'_>> {
    let (count, mut data) = bytes.split_at_checked(4)?;
    let count = i32::from_ne_bytes(count.try_into().ok()?);
    if !(1..=4096).contains(&count) || string(&mut data)?.is_empty() {
        return None;
    }
    padding(&mut data);
    let argv = (0..count)
        .map(|_| string(&mut data))
        .collect::<Option<Vec<_>>>()?;
    padding(&mut data);
    let mut environment = Vec::new();
    while !data.is_empty() && data[0] != 0 {
        let entry = string(&mut data)?;
        let split = entry.iter().position(|&b| b == b'=')?;
        if split == 0 {
            return None;
        }
        environment.push((&entry[..split], &entry[split + 1..]));
    }
    Some(Arguments { argv, environment })
}
#[cfg(target_os = "macos")]
pub(super) fn context(id: &super::native::Identity) -> Option<super::native::Context> {
    use super::native::{identity, Context};
    use std::{ffi::OsStr, mem, os::unix::ffi::OsStrExt, path::PathBuf, ptr};
    if identity(id.pid).as_ref() != Some(id) {
        return None;
    }
    unsafe {
        let len = mem::size_of::<libc::proc_vnodepathinfo>() as i32;
        let mut vnode = mem::MaybeUninit::<libc::proc_vnodepathinfo>::uninit();
        if libc::proc_pidinfo(
            id.pid as _,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            vnode.as_mut_ptr().cast(),
            len,
        ) != len
        {
            return None;
        }
        let node = vnode.assume_init();
        let bytes = std::slice::from_raw_parts(
            node.pvi_cdir.vip_path.as_ptr().cast::<u8>(),
            mem::size_of_val(&node.pvi_cdir.vip_path),
        );
        let cwd = PathBuf::from(OsStr::from_bytes(
            &bytes[..bytes.iter().position(|&c| c == 0)?],
        ));
        // Fetch the bounded KERN_PROCARGS2 buffer, then perform a second native
        // identity check before releasing the recovered context to its caller.
        let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, id.pid as i32];
        let mut capacity = 0;
        if libc::sysctl(
            mib.as_mut_ptr(),
            3,
            ptr::null_mut(),
            &mut capacity,
            ptr::null_mut(),
            0,
        ) != 0
            || !(4..=2 * 1024 * 1024).contains(&capacity)
        {
            return None;
        }
        let mut buffer = vec![0u8; capacity];
        if libc::sysctl(
            mib.as_mut_ptr(),
            3,
            buffer.as_mut_ptr().cast(),
            &mut capacity,
            ptr::null_mut(),
            0,
        ) != 0
        {
            return None;
        }
        let args = parse(buffer.get(..capacity)?)?;
        let ctx = Context {
            id: id.clone(),
            cwd,
            argv: args
                .argv
                .into_iter()
                .map(|v| OsStr::from_bytes(v).to_owned())
                .collect(),
            env: args
                .environment
                .into_iter()
                .map(|(k, v)| {
                    (
                        OsStr::from_bytes(k).to_owned(),
                        OsStr::from_bytes(v).to_owned(),
                    )
                })
                .collect(),
        };
        (identity(id.pid).as_ref() == Some(id)).then_some(ctx)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_argv_preserves_an_empty_argument_and_keeps_environment_private() {
        let mut bytes = 3i32.to_ne_bytes().to_vec();
        bytes.extend_from_slice(b"/bin/node\0\0node\0\0server.js\0\0TEST_KEY=a=b\0\0unused\0");
        let args = parse(&bytes).unwrap();
        assert_eq!(args.argv, vec![b"node".as_slice(), b"", b"server.js"]);
        assert_eq!(
            args.environment,
            vec![(b"TEST_KEY".as_slice(), b"a=b".as_slice())]
        );
        bytes.pop();
        let count = (4097i32).to_ne_bytes();
        bytes[..4].copy_from_slice(&count);
        assert!(parse(&bytes).is_none());
    }
}
