release:
	rm -rf node_modules
	npm install
	git tag -d latest
	git branch release-latest
	git checkout release-latest
	git add -f node_modules/
	git commit -m "Latest Release"
	git push --set-upstream origin release-latest
	git tag -a latest -m "Latest Release"
	git push origin latest --force
	git checkout master
	git push origin --delete release-latest
	git branch -D release-latest
	git reflog expire --all --expire=now
	git gc

