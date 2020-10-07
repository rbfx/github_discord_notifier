release:
	rm -rf node_modules
	npm install
	git push origin --delete latest
	git branch release-latest
	git checkout release-latest
	git add -f node_modules/
	git commit -m "Latest Release"
	git push --set-upstream origin release-latest
	-gh release create latest -t "Latest release" -n '' --target release-latest
	git checkout master
	git push origin --delete release-latest
	git branch -D release-latest
	git reflog expire --all --expire=now
	git gc

