"""Create the first admin account, printing its one-time password once.

    python scripts/seed_admin.py --username fati

Refuses to run if an admin already exists, so it cannot be used to mint a second
administrator on a live install. The password is generated here, shown once, and
stored only as an Argon2id hash -- there is no way to recover it, and the
account cannot reach a single image until it has been replaced.
"""
import argparse, os, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'app'))
import db
import security as sec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--username', required=True)
    ap.add_argument('--display-name', default='')
    a = ap.parse_args()

    db.init()
    con = db.connect()
    try:
        if con.execute("SELECT 1 FROM users WHERE role='admin'").fetchone():
            sys.exit('An admin already exists. Use the admin console to add more.')
        if con.execute('SELECT 1 FROM users WHERE username=?',
                       (a.username,)).fetchone():
            sys.exit('That username is taken.')
        temp = sec.new_temp_password()
        con.execute(
            'INSERT INTO users (username, display_name, role, pw_hash,'
            ' must_change_pw, created_at) VALUES (?,?,?,?,1,?)',
            (a.username, a.display_name or a.username, 'admin',
             sec.hash_pw(temp), time.time()))
        db.audit(con, None, 'admin_seeded', a.username, None, None)
        print('username: %s' % a.username)
        print('password: %s' % temp)
        print('\nShown once. You must change it at first sign-in.')
    finally:
        con.close()


if __name__ == '__main__':
    main()
