hash:=$(shell git rev-parse --short HEAD)

release:
	rm -rf node_modules
	npm install
	git branch release/$(hash)
	git checkout release/$(hash)
	git add -f node_modules/
	git commit -m "Release $(hash)"
	git push --set-upstream origin release/$(hash)
	gh release create $(hash) -t "Latest release" -n '' --target release/$(hash)
	git checkout master
	git push origin --delete release/$(hash)
	git branch -D release/$(hash)
	git reflog expire --all --expire=now
	git gc

