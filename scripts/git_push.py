import subprocess
import ctypes
import ctypes.wintypes

advapi32 = ctypes.windll.advapi32

class CREDENTIAL(ctypes.Structure):
    _fields_ = [
        ('Flags', ctypes.wintypes.DWORD),
        ('Type', ctypes.wintypes.DWORD),
        ('TargetName', ctypes.wintypes.LPWSTR),
        ('Comment', ctypes.wintypes.LPWSTR),
        ('LastWritten', ctypes.wintypes.FILETIME),
        ('CredentialBlobSize', ctypes.wintypes.DWORD),
        ('CredentialBlob', ctypes.POINTER(ctypes.c_byte)),
        ('Persist', ctypes.wintypes.DWORD),
        ('AttributeCount', ctypes.wintypes.DWORD),
        ('Attributes', ctypes.c_void_p),
        ('TargetAlias', ctypes.wintypes.LPWSTR),
        ('UserName', ctypes.wintypes.LPWSTR),
    ]

PCREDENTIAL = ctypes.POINTER(CREDENTIAL)
CredReadW = advapi32.CredReadW
CredReadW.argtypes = [ctypes.wintypes.LPCWSTR, ctypes.wintypes.DWORD, ctypes.wintypes.DWORD, ctypes.POINTER(PCREDENTIAL)]
CredReadW.restype = ctypes.wintypes.BOOL

cred = PCREDENTIAL()
if CredReadW('gh:github.com:wang111928', 1, 0, ctypes.byref(cred)):
    token = ctypes.string_at(cred.contents.CredentialBlob, cred.contents.CredentialBlobSize).decode('utf-8')
    def run(cmd_list):
        res = subprocess.run(cmd_list, capture_output=True, text=True, cwd=r'D:\Antighhh')
        print('CMD:', ' '.join(cmd_list))
        print('STDOUT:', res.stdout.strip())
        if res.stderr:
            print('STDERR:', res.stderr.strip())
        return res.returncode

    run(['git', 'init', '-b', 'main'])
    run(['git', 'add', '.'])
    run(['git', 'commit', '-m', 'feat: initial commit of vivo X100 Pro customized GKD subscription'])
    remote_auth_url = f'https://wang111928:{token}@github.com/wang111928/gkd-subscription.git'
    run(['git', 'remote', 'remove', 'origin'])
    run(['git', 'remote', 'add', 'origin', remote_auth_url])
    code = run(['git', 'push', '-u', 'origin', 'main', '--force'])
    # restore clean url without token
    run(['git', 'remote', 'set-url', 'origin', 'https://github.com/wang111928/gkd-subscription.git'])
    print('Final push code:', code)
else:
    print('Failed to read credential')
